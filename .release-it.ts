import type { Config } from 'release-it';

export default {
  git: {
    commitMessage: 'chore(release): v${version}',
    tagName: 'v${version}',
    push: true,
  },
  github: {
    release: true,
  },
  npm: {
    publish: true,
    publishPackageManager: 'pnpm',
    publishArgs: ['--no-git-checks'],
  },
  plugins: {
    '@release-it/conventional-changelog': {
      infile: 'CHANGELOG.md',
      preset: {
        name: 'conventionalcommits',
        types: [
          { type: 'feat', section: 'Features' },
          { type: 'fix', section: 'Bug Fixes' },
        ],
      },
    },
  },
  hooks: {
    'before:init': ['pnpm typecheck', 'pnpm lint', 'pnpm test'],
    'after:bump': 'pnpm build',
  },
} satisfies Config;
