# {{projectName}}

Cross-platform mobile app (iOS, Android, web) on Expo SDK 58 with expo-router and TypeScript.
Scaffolded by Forge (`expo`).

## Scripts

| Command             | What it does                                         |
| ------------------- | ---------------------------------------------------- |
| `npm install`       | Install dependencies                                 |
| `npm start`         | Expo dev server (scan the QR code with Expo Go)      |
| `npm run web`       | Run in the browser                                   |
| `npm run build:web` | Static web export into `dist/`                       |
| `npm run typecheck` | TypeScript                                           |
| `npm run lint`      | ESLint (`eslint-config-expo`)                        |
| `npm test`          | Logic tests (Vitest; pure TS, no native runtime)     |

## Native builds

`eas.json` defines `development`, `preview` and `production` profiles:

```sh
npx eas-cli build --platform android --profile preview --non-interactive
```

Requires `EXPO_TOKEN`. Forge runs this inside its sandbox and shows a QR code for the preview.

## Design tokens and accessibility

Colours, spacing, radii, type sizes and durations live in `src/theme/tokens.ts`; the test suite
checks WCAG AA contrast for both colour schemes. Screens use `accessibilityRole`, 48dp touch targets
and honour the OS reduce-motion setting (`useReducedMotion()` in `src/lib/motion.ts`).

## Deploy (web)

`Dockerfile` exports the web build and serves it from unprivileged nginx on port 8080.
