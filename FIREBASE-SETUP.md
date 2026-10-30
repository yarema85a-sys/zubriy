# Підключення хмарних акаунтів Зубрія

Сайт використовує Firebase Authentication для входу Зубрія за поштою й паролем, Cloud Firestore для наборів і чернеток, Firebase Hosting для HTTPS-адреси. Вхід Google у самому сайті не використовується.

## Один раз налаштувати Firebase

1. Створи проєкт Firebase у [Firebase Console](https://console.firebase.google.com/) і зареєструй у ньому вебзастосунок.
2. У **Authentication → Sign-in method** увімкни **Email/Password**.
3. У **Firestore Database** створи базу даних і опублікуй правила з `firestore.rules`.
4. Скопіюй вебконфігурацію з **Project settings → Your apps** у `firebase-config.js`, замінивши чотири значення `PASTE_...`.
5. Додай адресу сайту з Firebase Hosting у **Authentication → Settings → Authorized domains**, якщо її там ще немає.
6. Установи Firebase CLI (`npm install -g firebase-tools`), відкрий термінал у цій папці та виконай:

   ```powershell
   firebase login
   firebase use --add
   firebase deploy --only firestore:rules,hosting
   ```

7. Відкрий адресу, яку покаже Firebase Hosting. Саме HTTPS-версія сайту працює з хмарною автентифікацією; файл, відкритий напряму як `file://`, працює лише як локальна версія.

## Важливо

- Вебконфігурація Firebase призначена для клієнтського застосунку. Не додавай сюди приватний ключ сервісного акаунта.
- Правила Firestore прив’язують кожен документ до Firebase Auth UID власника. Не замінюй їх на публічний доступ.
- Старі локальні профілі можна перенести: на пристрої, де вони збережені, увійди в Зубрій з тією самою поштою та локальним паролем після налаштування Firebase. Сайт створить хмарний профіль і завантажить набори та чернетки. На інших пристроях далі використовуй цей акаунт Зубрія.
