import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/drizzle/**", "**/*.config.*"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  {
    files: ["apps/web/src/**"],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      // An effect's return value is its cleanup. An expression body returns whatever the call
      // returns (newer browsers return a Promise from scrollIntoView), and React then crashes.
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name=/^use(Layout)?Effect$/] > ArrowFunctionExpression[expression=true]",
          message: "Give effects a block body; an expression body becomes the cleanup function.",
        },
      ],
    },
  },
);
