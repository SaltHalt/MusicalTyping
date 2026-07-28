import globals from 'globals'

export default [{
  files: ['**/*.js'],
  ignores: ['dist/*'],
  languageOptions: {
    globals: {
      ...globals.node
    },
    ecmaVersion: 2022,
    sourceType: 'module'
  },
  rules: {
    'eol-last': ['error', 'always'],
    'no-throw-literal': 'warn',
    'quote-props': ['error', 'as-needed'],
    'constructor-super': 'warn',
    'no-const-assign': 'warn',
    'no-this-before-super': 'warn',
    'no-undef': 'warn',
    'no-unreachable': 'warn',
    'no-unused-vars': 'warn',
    'valid-typeof': 'warn',
    curly: ['error', 'multi-or-nest'],
    eqeqeq: 'error',
    quotes: ['error', 'single', { allowTemplateLiterals: true }],
    semi: ['error', 'never']
  }
}
]
