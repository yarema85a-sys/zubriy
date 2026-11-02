(function () {
  'use strict';

  const sdkVersion = '13.1.0';
  let modulesPromise = null;
  let app = null;
  let auth = null;
  let db = null;
  let firestoreSdk = null;
  let persistencePromise = null;
  const saveQueues = new Map();

  function config() {
    return window.ZUBRIY_FIREBASE_CONFIG || {};
  }

  function isConfigured() {
    const value = config();
    return ['apiKey', 'authDomain', 'projectId', 'appId'].every((key) =>
      typeof value[key] === 'string' && value[key].trim() && !value[key].includes('PASTE_')
    );
  }

  function loadFirebaseSdk() {
    if (!isConfigured()) {
      const error = new Error('Firebase is not configured for this site.');
      error.code = 'zubriy/cloud-not-configured';
      return Promise.reject(error);
    }
    if (!modulesPromise) {
      const root = 'https://www.gstatic.com/firebasejs/' + sdkVersion + '/';
      modulesPromise = Promise.all([
        import(root + 'firebase-app.js'),
        import(root + 'firebase-auth.js'),
        import(root + 'firebase-firestore.js')
      ]).then(([appApi, authApi, firestoreApi]) => {
        app = appApi.getApps().find((item) => item.options.projectId === config().projectId) || appApi.initializeApp(config());
        auth = authApi.getAuth(app);
        db = firestoreApi.getFirestore(app);
        firestoreSdk = firestoreApi;
        return {appApi, authApi, firestoreApi};
      }).catch((error) => {
        modulesPromise = null;
        throw error;
      });
    }
    return modulesPromise;
  }

  async function ready() {
    const apis = await loadFirebaseSdk();
    if (!persistencePromise) persistencePromise = apis.authApi.setPersistence(auth, apis.authApi.browserLocalPersistence);
    await persistencePromise;
    return apis;
  }

  function userInfo(user) {
    return user ? {id: user.uid, uid: user.uid, email: user.email || '', name: user.displayName || (user.email || '').split('@')[0] || 'Учень'} : null;
  }

  function userRef(uid, collectionName) {
    return firestoreSdk.collection(db, 'users', uid, collectionName);
  }

  function snapshotFromQueries(setSnapshot, draftSnapshot) {
    const orderedSets = [];
    setSnapshot.forEach((item) => {
      const data = item.data();
      const payload = data.payload;
      if (typeof payload !== 'string') return;
      try {
        const set = JSON.parse(payload);
        if (set && typeof set.id === 'string' && Array.isArray(set.terms)) {
          orderedSets.push({set, order: Number.isInteger(data.order) ? data.order : Number.MAX_SAFE_INTEGER});
        }
      } catch (_) {}
    });
    orderedSets.sort((left, right) => left.order - right.order);
    const sets = orderedSets.map((item) => item.set);
    const createDraft = null;
    const editDrafts = {};
    let savedCreateDraft = createDraft;
    draftSnapshot.forEach((item) => {
      const data = item.data();
      if (typeof data.payload !== 'string') return;
      if (data.kind === 'create') savedCreateDraft = data.payload;
      else if (data.kind === 'edit' && typeof data.setId === 'string') editDrafts[data.setId] = data.payload;
    });
    return {exists: true, sets, createDraft: savedCreateDraft, editDrafts};
  }

  async function currentApisFor(uid) {
    const apis = await ready();
    const current = auth.currentUser;
    if (!current || current.uid !== uid) {
      const error = new Error('The signed-in account changed before the cloud operation completed.');
      error.code = 'zubriy/session-changed';
      throw error;
    }
    return apis;
  }

  function encodeDocumentId(value) {
    const bytes = new TextEncoder().encode(String(value));
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '') || '_';
  }

  async function createAccount(email, password, name) {
    const apis = await ready();
    const credential = await apis.authApi.createUserWithEmailAndPassword(auth, email, password);
    await apis.authApi.updateProfile(credential.user, {displayName: name});
    return userInfo(credential.user);
  }

  async function signIn(email, password) {
    const apis = await ready();
    const credential = await apis.authApi.signInWithEmailAndPassword(auth, email, password);
    return userInfo(credential.user);
  }

  async function signOut() {
    const apis = await ready();
    await apis.authApi.signOut(auth);
  }

  async function restoreSession() {
    const apis = await ready();
    return new Promise((resolve, reject) => {
      let unsubscribe = null;
      unsubscribe = apis.authApi.onAuthStateChanged(auth, (user) => {
        if (unsubscribe) unsubscribe();
        resolve(userInfo(user));
      }, (error) => {
        if (unsubscribe) unsubscribe();
        reject(error);
      });
    });
  }

  async function readWorkspace(uid) {
    const apis = await currentApisFor(uid);
    const [setSnapshot, draftSnapshot, metaSnapshot] = await Promise.all([
      apis.firestoreApi.getDocs(userRef(uid, 'sets')),
      apis.firestoreApi.getDocs(userRef(uid, 'drafts')),
      apis.firestoreApi.getDoc(apis.firestoreApi.doc(db, 'users', uid, 'meta', 'workspace'))
    ]);
    const state = snapshotFromQueries(setSnapshot, draftSnapshot);
    state.exists = metaSnapshot.exists() || setSnapshot.size > 0 || draftSnapshot.size > 0;
    return state;
  }

  async function saveWorkspace(uid, state) {
    const apis = await currentApisFor(uid);
    const {firestoreApi} = apis;
    const setsCollection = userRef(uid, 'sets');
    const draftsCollection = userRef(uid, 'drafts');
    const [oldSets, oldDrafts, meta] = await Promise.all([
      firestoreApi.getDocs(setsCollection),
      firestoreApi.getDocs(draftsCollection),
      firestoreApi.getDoc(firestoreApi.doc(db, 'users', uid, 'meta', 'workspace'))
    ]);
    const expectedSets = new Map();
    (Array.isArray(state.sets) ? state.sets : []).forEach((set, order) => {
      if (!set || typeof set.id !== 'string' || !set.id) return;
      expectedSets.set(encodeDocumentId(set.id), {id: set.id, order, payload: JSON.stringify(set)});
    });
    const expectedDrafts = new Map();
    if (typeof state.createDraft === 'string') expectedDrafts.set('create', {kind: 'create', payload: state.createDraft});
    const editDrafts = state.editDrafts && typeof state.editDrafts === 'object' ? state.editDrafts : {};
    Object.keys(editDrafts).forEach((setId) => {
      if (typeof editDrafts[setId] === 'string') {
        expectedDrafts.set('edit-' + encodeDocumentId(setId), {kind: 'edit', setId, payload: editDrafts[setId]});
      }
    });

    let batch = firestoreApi.writeBatch(db);
    let writes = 0;
    const commits = [];
    function queue(operation) {
      operation(batch);
      writes += 1;
      if (writes >= 400) {
        commits.push(batch.commit());
        batch = firestoreApi.writeBatch(db);
        writes = 0;
      }
    }

    oldSets.forEach((item) => {
      if (!expectedSets.has(item.id)) queue((target) => target.delete(item.ref));
    });
    expectedSets.forEach((value, documentId) => {
      const old = oldSets.docs.find((item) => item.id === documentId);
      if (!old || old.data().payload !== value.payload || old.data().order !== value.order) {
        queue((target) => target.set(firestoreApi.doc(setsCollection, documentId), value));
      }
    });
    oldDrafts.forEach((item) => {
      if (!expectedDrafts.has(item.id)) queue((target) => target.delete(item.ref));
    });
    expectedDrafts.forEach((value, documentId) => {
      const old = oldDrafts.docs.find((item) => item.id === documentId);
      if (!old || old.data().payload !== value.payload || old.data().kind !== value.kind || old.data().setId !== value.setId) {
        queue((target) => target.set(firestoreApi.doc(draftsCollection, documentId), value));
      }
    });
    if (!meta.exists()) {
      queue((target) => target.set(firestoreApi.doc(db, 'users', uid, 'meta', 'workspace'), {version: 1, createdAt: firestoreApi.serverTimestamp()}));
    }
    if (writes) commits.push(batch.commit());
    for (const commit of commits) await commit;
    return {exists: true};
  }

  function watchWorkspace(uid, onChange) {
    let setSnapshot = null;
    let draftSnapshot = null;
    let stopped = false;
    const apisPromise = currentApisFor(uid);
    let stopSets = null;
    let stopDrafts = null;
    apisPromise.then((apis) => {
      if (stopped) return;
      stopSets = apis.firestoreApi.onSnapshot(userRef(uid, 'sets'), (snapshot) => {
        setSnapshot = snapshot;
        if (draftSnapshot) onChange(snapshotFromQueries(setSnapshot, draftSnapshot));
      }, (error) => window.dispatchEvent(new CustomEvent('zubriy-cloud-error', {detail: error})));
      stopDrafts = apis.firestoreApi.onSnapshot(userRef(uid, 'drafts'), (snapshot) => {
        draftSnapshot = snapshot;
        if (setSnapshot) onChange(snapshotFromQueries(setSnapshot, draftSnapshot));
      }, (error) => window.dispatchEvent(new CustomEvent('zubriy-cloud-error', {detail: error})));
    }).catch((error) => window.dispatchEvent(new CustomEvent('zubriy-cloud-error', {detail: error})));
    return () => {
      stopped = true;
      if (stopSets) stopSets();
      if (stopDrafts) stopDrafts();
    };
  }

  async function flush(uid) {
    const queue = saveQueues.get(uid);
    if (!queue) return;
    clearTimeout(queue.timer);
    if (queue.inFlight) await queue.inFlight;
    if (!queue.snapshot) return;
    const generation = queue.generation;
    const snapshot = queue.snapshot;
    queue.inFlight = saveWorkspace(uid, snapshot);
    let saved = false;
    try {
      await queue.inFlight;
      saved = true;
      window.dispatchEvent(new CustomEvent('zubriy-cloud-saved', {detail: {uid}}));
    } catch (error) {
      window.dispatchEvent(new CustomEvent('zubriy-cloud-error', {detail: error}));
    } finally {
      queue.inFlight = null;
      if (generation !== queue.generation) {
        clearTimeout(queue.timer);
        queue.timer = setTimeout(() => flush(uid), 0);
      }
      else if (saved) queue.snapshot = null;
    }
  }

  function queueSave(uid, state) {
    let queue = saveQueues.get(uid);
    if (!queue) {
      queue = {snapshot: null, generation: 0, timer: null, inFlight: null};
      saveQueues.set(uid, queue);
    }
    queue.snapshot = JSON.parse(JSON.stringify(state));
    queue.generation += 1;
    clearTimeout(queue.timer);
    queue.timer = setTimeout(() => flush(uid), 700);
  }

  window.addEventListener('online', () => {
    saveQueues.forEach((queue, uid) => {
      if (queue.snapshot && !queue.timer) queue.timer = setTimeout(() => flush(uid), 100);
    });
  });

  async function reauthenticate(password) {
    const apis = await ready();
    if (!auth.currentUser || !auth.currentUser.email) throw new Error('Немає активного хмарного акаунта.');
    const credential = apis.authApi.EmailAuthProvider.credential(auth.currentUser.email, password);
    await apis.authApi.reauthenticateWithCredential(auth.currentUser, credential);
  }

  async function updateDisplayName(name) {
    const apis = await ready();
    if (!auth.currentUser) throw new Error('Немає активного хмарного акаунта.');
    await apis.authApi.updateProfile(auth.currentUser, {displayName: name});
    return userInfo(auth.currentUser);
  }

  async function changePassword(currentPassword, newPassword) {
    const apis = await ready();
    await reauthenticate(currentPassword);
    await apis.authApi.updatePassword(auth.currentUser, newPassword);
  }

  function sharedIdFor(uid, setId) {
    return encodeDocumentId(uid + '|' + setId);
  }

  async function publishSet(setId, meta, setData) {
    const apis = await ready();
    const current = auth.currentUser;
    if (!current) throw new Error('Немає активного хмарного акаунта.');
    await apis.firestoreApi.setDoc(apis.firestoreApi.doc(db, 'shared', sharedIdFor(current.uid, setId)), {
      ownerUid: current.uid,
      ownerName: String(meta.ownerName || 'Учень').slice(0, 48),
      title: String(meta.title || '').slice(0, 120),
      category: String(meta.category || '').slice(0, 40),
      description: String(meta.description || '').slice(0, 300),
      count: Number(meta.count) || 0,
      data: JSON.stringify(setData),
      createdAt: apis.firestoreApi.serverTimestamp()
    });
  }

  async function unpublishSet(setId) {
    const apis = await ready();
    const current = auth.currentUser;
    if (!current) throw new Error('Немає активного хмарного акаунта.');
    await apis.firestoreApi.deleteDoc(apis.firestoreApi.doc(db, 'shared', sharedIdFor(current.uid, setId)));
  }

  async function listShared() {
    const apis = await ready();
    if (!auth.currentUser) throw new Error('Немає активного хмарного акаунта.');
    const snapshot = await apis.firestoreApi.getDocs(apis.firestoreApi.collection(db, 'shared'));
    const items = [];
    snapshot.forEach((item) => {
      const data = item.data();
      let set = null;
      try { set = JSON.parse(data.data); } catch (_) {}
      if (!set || !Array.isArray(set.terms)) return;
      items.push({
        shareId: item.id,
        ownerUid: data.ownerUid || '',
        ownerName: data.ownerName || 'Учень',
        title: data.title || set.title || '',
        category: data.category || '',
        description: data.description || '',
        count: Number(data.count) || set.terms.length,
        createdAt: data.createdAt && typeof data.createdAt.toMillis === 'function' ? data.createdAt.toMillis() : 0,
        set: set
      });
    });
    return items;
  }

  window.ZubriyCloud = {
    isConfigured,
    createAccount,
    signIn,
    signOut,
    restoreSession,
    readWorkspace,
    saveWorkspace,
    watchWorkspace,
    queueSave,
    flush,
    reauthenticate,
    updateDisplayName,
    changePassword,
    publishSet,
    unpublishSet,
    listShared,
    getCurrentUser: async () => { await ready(); return userInfo(auth.currentUser); }
  };
})();
eady(); return userInfo(auth.currentUser); }
  };
})();
