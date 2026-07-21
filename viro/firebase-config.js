// Firebase Console → Project settings → General → Your apps → SDK setup and configuration.
// This config is safe to be public — it is not a secret. Real protection comes from
// Firebase Authentication + the Firestore security rules (set those in the Firebase console).
export const firebaseConfig = {
  apiKey: 'AIzaSyAHQA-jRZCKuxqjB7rxKwLNtq9tco5t1EY',
  authDomain: 'aidenyue.firebaseapp.com',
  projectId: 'aidenyue',
  storageBucket: 'aidenyue.firebasestorage.app',
  messagingSenderId: '782944461874',
  appId: '1:782944461874:web:2b9300a4cb22299162882b'
};

// The fixed internal account used to sign in with just the PIN. It does not need to be a
// real, reachable email address — Firebase Authentication just needs it as a unique identifier.
export const PORTAL_ACCOUNT_EMAIL = 'aiden@viro.local';

// Google Cloud Console → APIs & Services → Credentials.
// OAuth 2.0 Client ID (Web application) used to connect Google Calendar. Public/safe like the
// Firebase config above — it only identifies the app; it can't authenticate anything by itself.
export const GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com';

// Places API (New) key, used client-side to search for a location by name (e.g. "mcdonalds")
// when adding a calendar event. Restrict this key to your site's HTTP referrer in Google Cloud
// Console — Google explicitly designs Places/Maps keys to be used this way in browser apps.
export const GOOGLE_PLACES_API_KEY = 'YOUR_GOOGLE_PLACES_API_KEY';
