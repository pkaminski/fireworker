'use strict';

const buble = require('buble');
const composeSourceMap = require('compose-source-map');
const path = require('path');

module.exports = function(grunt) {
  grunt.registerMultiTask('buble', function() {
    this.files.forEach(file => {
      const options = this.options();
      if (file.src.length > 1) grunt.log.fatal('only one src file accepted per dest');
      const src = file.src[0];
      const dest = file.dest || src;
      const result = buble.transform(grunt.file.read(src), {
        file: path.basename(dest), source: path.basename(src), transforms: {dangerousForOf: true}
      });
      grunt.file.write(dest, result.code);
      if (options.sourceMap) {
        let map = result.map;
        delete map.sourcesContent;
        if (options.sourceMapIn) {
          const mapSrc = grunt.util.kindOf(options.sourceMapIn) === 'function' ?
            options.sourceMapIn(src) : options.sourceMapIn;
          map = composeSourceMap(grunt.file.readJSON(mapSrc), map);
        }
        const mapDest = (grunt.util.kindOf(options.sourceMapName) === 'function' ?
            options.sourceMapName(src) : options.sourceMapName) || (dest + '.map');
        grunt.file.write(mapDest, JSON.stringify(map));
      }
    });
  });
};
