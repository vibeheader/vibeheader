// Used by Jest (via babel-jest) to transform ES module syntax in src/ and tests/.
module.exports = {
  presets: [['@babel/preset-env', { targets: { node: 'current' } }]],
};
