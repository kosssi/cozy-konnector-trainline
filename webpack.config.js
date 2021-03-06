var path = require('path')
const CopyPlugin = require('copy-webpack-plugin')

module.exports = {
  entry: require('./package.json').main,
  target: 'node',
  output: {
    path: path.join(__dirname, 'build'),
    filename: 'index.js'
  },
  plugins: [
    new CopyPlugin([
      { from: 'manifest.konnector' },
      { from: 'package.json' },
      { from: 'LICENSE' },
      { from: 'assets' }
    ])
  ]
}
