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
