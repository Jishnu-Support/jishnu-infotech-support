# Jishnu Infotech Support browser extension

This Manifest V3 extension works in current Google Chrome and Microsoft Edge on Windows. It provides a portal shortcut and can start a ticket draft from the current page. Page title, URL, and selected text are put in an editable draft; nothing is submitted until the signed-in user reviews and submits the ticket in the portal.

## Install in Chrome or Edge on Windows

1. Extract `Jishnu-Support-Browser-Extension.zip` to a folder you can keep, such as `Documents\Jishnu-Support-Browser-Extension`.
2. Open `chrome://extensions` in Chrome, or `edge://extensions` in Edge.
3. Turn on **Developer mode**.
4. Select **Load unpacked** and choose the extracted `browser-extension` folder (the folder containing `manifest.json`).
5. Pin **Jishnu Infotech Support** from the extensions menu. Click its toolbar icon to open the portal or create a ticket from the active web page.

The extension defaults to `https://jitsupport.jishnuinfotech.com`. To point it elsewhere, open the extension, expand **Portal address**, enter the site's HTTPS URL, and save it.

For local development, use `http://localhost:5173` as the portal address.
