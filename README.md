# Draft Night — Fantasy Board

Tablero de draft para fantasy football. Sitio estático (HTML/CSS/JS sin
build step) pensado para usarse durante un draft en vivo.

## Funciones

- Board de jugadores con filtros por posición, tier y búsqueda, y con
  ordenamiento por ADP, alfabético o por tus rankings personalizados.
- **Mis Rankings**: pestaña para reordenar jugadores a tu gusto (arrastrar
  o con las flechas ▲▼) y editar el tier de cada uno. Es personal — se
  guarda en tu navegador, no se comparte con la sala.
- **Mi equipo**: roster con objetivos por posición, valor vs. ADP de cada
  pick, y botón para reiniciar el draft.
- Modo claro/oscuro, deshacer última jugada, y todo funciona en mobile.
- **Multijugador en vivo** (opcional): comparte un código de sala para que
  varias personas vean el mismo draft actualizarse en tiempo real.

## Uso local

No requiere instalación. Sirve la carpeta `public/` con cualquier servidor
estático, por ejemplo:

```bash
npx http-server public
# o
python3 -m http.server 8000 --directory public
```

## Activar el multijugador en vivo (opcional)

Sin configurar nada, la app funciona en **modo local**: el draft se guarda
solo en tu navegador. Para que varias personas compartan el mismo draft en
tiempo real:

1. Crea un proyecto gratuito en la [consola de Firebase](https://console.firebase.google.com).
2. Activa **Firestore Database** (modo producción, cualquier región).
3. En "Configuración del proyecto → Tus apps", crea una app web y copia el
   objeto `firebaseConfig`.
4. Pégalo en `public/firebase-config.js`, reemplazando los valores
   `YOUR_...`.
5. En Firestore, publica las reglas de `firestore.rules` (están pensadas
   para este caso de uso: sin datos sensibles, cualquiera con el código de
   sala puede leer/escribir esa sala).
6. Despliega. En la app, abre el ícono de multijugador (junto a tu
   nombre) → **Crear sala nueva**, y comparte el enlace con `?room=CÓDIGO`.

Los valores de `firebaseConfig` no son secretos (Firebase los protege con
las reglas de seguridad, no ocultándolos), así que es seguro publicarlos
en el repositorio y en el sitio estático.

## Despliegue en GitHub Pages

Ya incluye un workflow (`.github/workflows/deploy-pages.yml`) que publica
la carpeta `public/` en GitHub Pages en cada push a `main`. Solo hace
falta activarlo una vez:

1. En GitHub: **Settings → Pages → Build and deployment → Source**,
   selecciona **GitHub Actions**.
2. Haz push a `main` (o ejecuta el workflow manualmente desde la pestaña
   **Actions**).
3. El sitio queda publicado en `https://<usuario>.github.io/<repo>/`.

## Despliegue en Firebase Hosting (alternativa)

El repo conserva `firebase.json` por si prefieres Firebase Hosting en vez
de GitHub Pages:

```bash
npm install -g firebase-tools
firebase login
firebase deploy
```

## Estructura

```
public/
  index.html          markup
  style.css            estilos (tema claro/oscuro vía CSS variables)
  app.js               lógica de la app (ES module)
  players.js           base de datos de jugadores
  firebase-config.js   config de Firebase para multijugador (opcional)
firestore.rules         reglas de ejemplo para el modo multijugador
.github/workflows/      despliegue automático a GitHub Pages
```
