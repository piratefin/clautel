# Patches for free license fork

- **license.ts** — Replacement for `src/license.ts` that removes license checks and reports Max plan (unlimited bots).

After pulling upstream changes, run from the project root:

```bash
npm run apply-free-license
```

or `node scripts/apply-free-license.mjs` to re-apply the free license.
