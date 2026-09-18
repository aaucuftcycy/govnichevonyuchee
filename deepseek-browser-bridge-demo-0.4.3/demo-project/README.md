# Demo project

This tiny project intentionally contains a bug in `src/calculator.js` so you can
verify that the local CLI can send real project files to DeepSeek through the browser.

Try:

```bash
cd ..
npm run ask -- --file demo-project/src/calculator.js "Find the bug in average() and explain the fix."
```
