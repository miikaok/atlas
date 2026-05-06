import tseslint from 'typescript-eslint';
import checkFile from 'eslint-plugin-check-file';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/', '**/dist/', 'node_modules/', '**/node_modules/', 'coverage/', '*.config.*'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['packages/*/src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./packages/*/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'check-file': checkFile,
    },
    rules: {
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'check-file/filename-naming-convention': [
        'error',
        { '**/*.ts': 'KEBAB_CASE' },
        { ignoreMiddleExtensions: true },
      ],
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'variable',
          format: ['snake_case', 'UPPER_CASE'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'function',
          format: ['snake_case', 'camelCase'],
        },
        {
          selector: 'parameter',
          format: ['snake_case'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
        {
          selector: 'enumMember',
          format: ['UPPER_CASE'],
        },
        {
          selector: 'classProperty',
          format: ['snake_case', 'UPPER_CASE'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'classMethod',
          format: ['snake_case', 'camelCase'],
        },
        {
          selector: 'objectLiteralProperty',
          format: null,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-function-return-type': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unnecessary-type-constraint': 'warn',
      '@typescript-eslint/no-wrapper-object-types': 'warn',
    },
  },
  {
    files: ['packages/*/tests/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./packages/*/tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'check-file': checkFile,
    },
    rules: {
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'check-file/filename-naming-convention': [
        'error',
        { '**/*.ts': 'KEBAB_CASE' },
        { ignoreMiddleExtensions: true },
      ],
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'variable',
          format: ['snake_case', 'UPPER_CASE'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'function',
          format: ['snake_case', 'camelCase'],
        },
        {
          selector: 'parameter',
          format: ['snake_case'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
        {
          selector: 'enumMember',
          format: ['UPPER_CASE'],
        },
        {
          selector: 'classProperty',
          format: ['snake_case', 'UPPER_CASE'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'classMethod',
          format: ['snake_case', 'camelCase'],
        },
        {
          selector: 'objectLiteralProperty',
          format: null,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unnecessary-type-constraint': 'warn',
      '@typescript-eslint/no-wrapper-object-types': 'warn',
    },
  },
  {
    files: ['packages/cli/src/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['packages/sdk/src/**/*.ts'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
  prettierConfig,
);
