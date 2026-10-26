# Habit Pings Android app

A thin Capacitor shell that loads https://habit-pings.onrender.com and receives
push notifications through Firebase Cloud Messaging (FCM).

The APK is built by `.github/workflows/android.yml`. It needs one repository
secret, `GOOGLE_SERVICES_JSON` (the contents of `google-services.json` for the
Android app `com.habitpings.app` registered in your Firebase project).
Run the workflow from the Actions tab (or push a change under `capacitor/`);
the APK appears under Releases as `habit-pings.apk`.
