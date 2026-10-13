# Jishnu Infotech Support Android launcher

This tiny Android app opens `https://jitsupport.jishnuinfotech.com` in the phone's default browser. It does not store credentials or handle sign-in inside the app. The launcher uses the company's red mark as its app icon.

## Build

On Windows with Java and Android SDK Platform 36 / Build Tools 36.1.0 installed, run the `build-apk.ps1` script from this folder. The signed APK is written to the repository root as `JishnuInfotechSupport.apk`. The signing key and build intermediates remain under the ignored `build` directory. Keep that directory backed up privately if you plan to publish compatible app updates; it contains the signing key and its password.

## Install on a phone

Transfer `JishnuInfotechSupport.apk` to the Android phone and open it to install. Approve the phone's **Install unknown apps** prompt for the app used to open the file if Android requests it. After installation, tap **Jishnu Infotech Support** in the app list; Android will open the portal in the phone's default browser.
