import { OptionDefaults } from 'typedoc';

/** @type {import('typedoc').TypeDocOptions} */
export default {
  entryPoints: ['src/index.ts'],
  tsconfig: './tsconfig.build.json',
  out: 'dist-wiki',
  plugin: ['typedoc-plugin-markdown'],

  blockTags: [...OptionDefaults.blockTags, '@note'],

  entryFileName: 'Home.md',
  flattenOutputFiles: true,

  excludeInternal: true,
  excludePrivate: true,
  excludeProtected: false,

  intentionallyNotExported: [
    'RtuTimingValue',
    'AbstractPhysicalLayerEvents',
    'AbstractPipelineLayerEvents',
    'ModbusMasterEvents',
    'ModbusSlaveEvents',
    'CallbackArgs',
    'CallbackLazy',
  ],

  hidePageHeader: true,
  hideBreadcrumbs: true,
  hidePageTitle: false,

  cleanOutputDir: true,
  includeVersion: true,
  sort: ['kind', 'instance-first', 'alphabetical'],
  visibilityFilters: {
    protected: true,
    private: false,
    inherited: true,
  },
};
