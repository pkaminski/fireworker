'use strict';

module.exports = function(grunt) {

  require('load-grunt-tasks')(grunt);
  require('./build/grunt_buble.js')(grunt);

  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),

    clean: {
      dist: ['dist']
    },

    buble: {
      options: {
        sourceMap: true
      },
      client: {
        src: 'src/client.js',
        dest: 'dist/client.js'
      },
      worker: {
        src: 'src/worker.js',
        dest: 'dist/worker.js'
      }
    },

    uglify: {
      options: {
        mangle: true,
        compress: true,
        sourceMap: true,
        sourceMapIn: src => src + '.map',
        sourceMapName: dest => dest + '.map',
      },
      client: {
        src: 'dist/client.js',
        dest: 'dist/client.min.js'
      },
      worker: {
        src: 'dist/worker.js',
        dest: 'dist/worker.min.js'
      }
    },

    gitadd: {
      dist: {
        src: 'dist/*'
      }
    },

    release: {
      options: {
        additionalFiles: ['bower.json'],
        beforeBump: ['default']
      }
    }

  });

  grunt.registerTask('default', [
    'clean:dist', 'buble', 'uglify', 'gitadd'
  ]);

};
