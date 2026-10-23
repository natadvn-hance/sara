// Conventional Commits; subjects may start with our identifiers (M0, C8, FR-...), so case is free.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'body-max-line-length': [0],
    'subject-case': [0],
    'header-max-length': [2, 'always', 120],
  },
}
