// Config de Firebase para el modo multi-usuario en vivo.
//
// Draft Night funciona perfectamente sin esto (modo local, un solo
// dispositivo). Para que varias personas vean el mismo draft en tiempo
// real, crea un proyecto gratuito en https://console.firebase.google.com,
// activa "Firestore Database" (modo producción) y pega aquí los valores
// de Configuración del proyecto → Tus apps → SDK setup and configuration.
//
// Ver README.md para las reglas de seguridad recomendadas.
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "000000000000",
  appId: "YOUR_APP_ID"
};

export const firebaseEnabled = firebaseConfig.apiKey !== "YOUR_API_KEY" && !!firebaseConfig.apiKey;
