# e2e-slug

A small dependency-free ES module that turns text into a URL-friendly slug:
lowercase ASCII letters and digits separated by single hyphens, with accents removed.

## Usage

```js
import { slugify } from './src/slugify.js';

slugify('Crème Brûlée!'); // 'creme-brulee'
```

Non-Latin characters are dropped, not transliterated. A non-string argument throws a `TypeError`.

## Test

```sh
npm run verify
```

Requires Node 22. There are no dependencies to install.
