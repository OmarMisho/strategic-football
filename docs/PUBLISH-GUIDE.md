# Publishing a new build to Google Play — checklist

## Signing (keystore)
- [ ] **Back up** `keystore/strategic-football-release.jks` + the password in a safe place
      (cloud vault / offline drive). If lost, you can NEVER update the app on Play.
- [ ] `keystore/` is git-ignored — never commit it.

## Rebuild process (after any code/server change)
```bash
# 1) Bundle web client + inject the public server URL
set SF_SERVER_URL=https://<your-public-url>     # e.g. your Koyeb/Render host
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

## Deploying the game server (free on Koyeb)
1. Create an account at koyeb.com (GitHub sign-in).
2. New App → "strategic-football".
3. New Service → deploy from your `OmarMisho/strategic-football` GitHub repo.
   - Build: **Dockerfile** (repo has one); Region: nearest your players.
   - Instance type: **Eco** (free, always-on for a turn-based game).
   - HTTP port: **8080**. Health check: `/health` (optional).
4. After deploy, open `<your-url>/health` → expect `{"ok":true,...}`.
5. Copy the URL (e.g. `https://strategic-football-abc.koyeb.app`) into `SF_SERVER_URL`
   above and rebuild the app before uploading to Play.

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