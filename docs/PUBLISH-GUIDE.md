# Publishing a new build to Google Play — checklist

## Signing (keystore)
- [ ] **Back up** `keystore/strategic-football-release.jks` + the password in a safe place
      (cloud vault / offline drive). If lost, you can NEVER update the app on Play.
- [ ] `keystore/` is git-ignored — never commit it.

## Rebuild process (after any code/server change)
```bash
# 1) Bundle web client + inject the public server URL
set SF_SERVER_URL=https://strategic-football.onrender.com   # or your real host
npm run web:build

# 2) Copy web assets into the Android project
npx cap sync android

# 3) Build signed release AAB (Play) + APK (test/sideload)
cd android
gradlew bundleRelease assembleRelease
cd ..

# Outputs:
#   android/app/build/outputs/bundle/release/app-release.aab   -> upload to Play Console
#   android/app/build/outputs/apk/release/app-release.apk      -> sideload test
```

## Version bumps
Before each Play upload, in `android/app/build.gradle`:
- `versionCode` → +1 (must increase each upload)
- `versionName` → e.g. `1.0.0` → `1.0.1`

## Google Play Console steps (first release)
1. Create a developer account at play.google.com/console (one-time $25).
2. New app → name `Strategic Football`, choose app category.
3. Store listing page (see STORE-LISTING.md for copy).
4. Content rating questionnaire (PEGI 3 — no violence, no purchases).
5. Data safety form → "no data shared", gameplay data/transient.
6. Privacy policy → host docs/PRIVACY-POLICY.md somewhere public (e.g. GitHub Pages/Render) and paste the URL.
7. App content → targets Android 13+, no Ads, no restricted content.
8. Production track → upload `app-release.aab` → review → publish.
9. Test your APK on a real phone first (or use internal-testing track).

## Server checklist (before enabling online play)
- [ ] Server deployed & reachable at `https://your-app.onrender.com`
- [ ] Health check passes: open `/health` in a browser → `{"ok":true,...}`
- [ ] Test: two phones, Create Room + Join, finish a full match