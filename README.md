# Aiden Yue · Portfolio

Personal portfolio at **https://aidenyue.com**, hosted from `main` with GitHub Pages.

## Public site

- `index.html`: biography, current ventures, Asynq Designs, experience, photos, and contact links.
- `portfolio.css`: responsive monochrome theme and animation styles.
- `portfolio.js`: scroll animation, theme preference, photo gallery, and the existing view counter.
- `assets/photos/`: optimized WebP versions of Aiden's supplied photographs.
- `assets/keyboard-basin.webp`: PBTfans Basin product render; source below.

The page is plain HTML, CSS, and JavaScript, with no installation or build step. Edit the files and push to `main`. Navigation and content work without JavaScript; animations respect reduced-motion settings. Short screens show the keyboard story in normal document flow. The gallery supports next/previous buttons, arrow keys, and Escape to close.

Google Fonts supplies Inter and Space Grotesk; system fonts remain available offline. The view counter retains its cached fallback when its external service is unavailable.

## Private portal

`viro/`, `functions/`, Firebase configuration, `styles.css`, and `script.js` retain their existing implementation. The public site has its own CSS and JavaScript so its redesign cannot change the portal's shared theme or behavior.

## Image credit

PBTfans Basin, designed by Asynq Designs. Product render via [KBDfans](https://kbdfans.com/products/pbtfans-doubleshot-basin).
