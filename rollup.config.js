import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import replace from '@rollup/plugin-replace';
import terser from '@rollup/plugin-terser';
import copy from 'rollup-plugin-copy';
import postcss from 'rollup-plugin-postcss';
import { rmSync } from 'node:fs';

const isProduction = process.env.NODE_ENV === 'production';
const buildEnv = process.env.BUILD_ENV || (isProduction ? 'prod' : 'dev');

export default [
  // Background script
  {
    input: 'src/background/background.js',
    output: {
      file: 'dist/background.js',
      format: 'iife'
    },
    plugins: [
      nodeResolve(),
      commonjs(),
      replace({
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
        preventAssignment: true
      }),
      isProduction && terser()
    ].filter(Boolean)
  },
  
  // Popup script
  {
    input: 'src/popup/popup.js',
    output: {
      file: 'dist/popup.js',
      format: 'iife'
    },
    plugins: [
      nodeResolve(),
      commonjs(),
      postcss({
        extract: 'popup.css',
        minimize: isProduction
      }),
      replace({
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
        preventAssignment: true
      }),
      isProduction && terser()
    ].filter(Boolean)
  },

  // Popup URL tester worker. User-provided regex runs off the UI thread and
  // the popup terminates this worker when one Filter exceeds the time budget.
  {
    input: 'src/popup/filter-match-worker.js',
    output: {
      file: 'dist/filter-match-worker.js',
      format: 'iife'
    },
    plugins: [
      nodeResolve(),
      commonjs(),
      replace({
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
        preventAssignment: true
      }),
      isProduction && terser()
    ].filter(Boolean)
  },
  
  // (Options removed for MVP)
  
  // Content script
  {
    input: 'src/content/content-script.js',
    output: {
      file: 'dist/content-script.js',
      format: 'iife'
    },
    plugins: [
      nodeResolve(),
      commonjs(),
      replace({
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
        preventAssignment: true
      }),
      isProduction && terser()
    ].filter(Boolean)
  },
  
  // Copy static files
  {
    input: 'src/copy-stub.js',
    output: {
      file: 'dist/temp.js'
    },
    plugins: [
      copy({
        targets: [
          { src: buildEnv === 'dev' ? 'manifest.dev.json' : 'manifest.prod.json', dest: 'dist', rename: 'manifest.json' },
          { src: 'src/popup/popup.html', dest: 'dist' },
          // copy icons to expected top-level paths for manifest
          { src: 'src/assets/icons/*', dest: 'dist/icons' }
        ]
      }),
      // the stub bundle only exists to run the copy plugin; drop its output so
      // dist/temp.js doesn't end up in the shipped package
      {
        name: 'remove-copy-stub',
        writeBundle() {
          rmSync('dist/temp.js', { force: true });
        }
      }
    ]
  }
];
