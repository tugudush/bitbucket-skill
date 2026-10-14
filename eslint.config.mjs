import js from '@eslint/js'
import globals from 'globals'
import prettier from 'eslint-config-prettier'

export default [
  {
    ignores: ['node_modules/', 'test-skill/'],
  },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  // Disables ESLint rules that conflict with Prettier; Prettier owns formatting.
  prettier,
]
