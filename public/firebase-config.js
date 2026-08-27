// Config de Firebase para el modo multi-usuario en vivo.
//
// TapOut funciona perfectamente sin esto (modo local, un solo
// dispositivo). Para que varias personas vean el mismo draft en tiempo
// real, crea un proyecto gratuito en https://console.firebase.google.com,
// activa "Firestore Database" (modo producción) y pega aquí los valores
// de Configuración del proyecto → Tus apps → SDK setup and configuration.
//
// Ver README.md para las reglas de seguridad recomendadas.
export const firebaseConfig = {
  apiKey: "AIzaSyBoVUGkby9m1WU7015LZL5baNcNL_50z_I",
  authDomain: "tapout-app-01.firebaseapp.com",
  projectId: "tapout-app-01",
  storageBucket: "tapout-app-01.firebasestorage.app",
  messagingSenderId: "275001977693",
  appId: "1:275001977693:web:c75e479b86fa884d0496b4",
  measurementId: "G-BYCNH7D9KK"
};

export const firebaseEnabled = firebaseConfig.apiKey !== "YOUR_API_KEY" && !!firebaseConfig.apiKey;
