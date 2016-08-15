#!/usr/bin/env node

try {
  var opts = JSON.parse(process.argv[2])
} catch (e) {
  console.log(
    'Usage: ./migrate.js \'{{JSON_OPTS}}\'\n' +
    '\n' +
    'JSON_OPTS Format:\n' +
    '\n' +
    '{"ownershipMap":{\n' +
    '  "klynch@gmail.com":"ben@drakontas.com",\n' +
    '  "jjsim@gmail.com": "jjsim@drakontas.com"}}\n'
  )
  process.exit()
}

require('string-format').extend(String.prototype)

require('./google-auth').init(function (authClient) {

  var drive = require('googleapis').drive({ version: 'v3', auth: authClient })

  var ownershipMaps = []
  for (var oldOwner in opts.ownershipMap) {
    newOwner = opts.ownershipMap[oldOwner]
    ownershipMaps.push([oldOwner, newOwner])
  }
  function migrateNext(i, callback) {
    var owners = ownershipMaps[i]
    if (!owners) return callback()
    console.log('migrate ' + owners[0] + ' to ' + owners[1])
    migrateOwnership(owners[0], owners[1], function (error) {
      if (error) console.error(error)
      migrateNext(i + 1, callback)
    })
  }
  migrateNext(0, function () {
    console.log('done')
    process.exit()
  })

  function fetchFiles(params, fileFn, callback) {
    drive.files.list(params, function (error, response) {
      if (error) {
        callback && callback(error)
      } else {
        function processNext(i) {
          var file = response.files[i]
          if (file) {
            fileFn(file, function (error) {
              if (error) console.error(error)
              processNext(i + 1)
            })
          } else {
            if (response.nextPageToken) {
              params.pageToken = response.nextPageToken
              fetchFiles(params, fileFn, callback)
            } else {
              callback && callback()
            }
          }
        }
        processNext(0)
      }
    })
  }

  var BACKUP_SUFFIX = '_ombak'
  var backupSuffixRegExp = new RegExp(BACKUP_SUFFIX + '$')

  function migrateOwnership(oldOwner, newOwner, callback) {
    fetchFiles({
      q: "'{0}' in owners".format(oldOwner),
      fields: 'nextPageToken, files(id, name, mimeType, owners, parents)',
      spaces: 'drive'
    }, function (file, _callback) {
      console.log('  "' + file.name + '" [' + file.id + ']')
      //console.log(file)
      //console.log('')

      if (!file.parents || !file.parents.length) {
      
        console.log('    skip (no parents)')
        _callback()
        return
      }

      if (file.name.match(backupSuffixRegExp)) {
        //console.log('      remove old backup and skip')
        //drive.files.update({
        //  fileId: file.id,
        //  removeParents: file.parents.join(',')
        //}, _callback)
        //return
        console.log('    continue for interrupted file')
        file.name = file.name.replace(backupSuffixRegExp, '')
      }

      var backupName = file.name + BACKUP_SUFFIX
      console.log('    create backup')
      drive.files.update({
        fileId: file.id,
        resource: {
          name: backupName
        }
      }, function (error, response) {
        if (error) {
          _callback(error)
        } else {
          if (file.mimeType == 'application/vnd.google-apps.folder') {
            console.log('    new folder')
            drive.files.create({
              resource: {
                name: file.name,
                parents: file.parents,
                mimeType: file.mimeType,
                fields: 'id'
              }
            }, function (error, newFolder) {
              if (error) {
                _callback(error)
              } else {
                console.log('      move files to new folder')
                fetchFiles({
                  q: "'{0}' in parents".format(file.id),
                  fields: 'nextPageToken, files(id, parents)',
                  spaces: 'drive'
                }, function (childFile, __callback) {
                  drive.files.update({
                    fileId: childFile.id,
                    removeParents: childFile.parents.join(','),
                    addParents: newFolder.id
                  }, __callback)
                }, function (error) {
                  if (error) {
                    _callback(error)
                  } else {
                    console.log('    remove old folder')
                    drive.files.update({
                      fileId: file.id,
                      removeParents: file.parents.join(',')
                    }, _callback)
                  }
                })
              }
            })
          } else {
            console.log('    copy')
            drive.files.copy({
              fileId: file.id,
              resource: {
                name: file.name,
                parents: file.parents
              }
            }, function (error, response) {
              if (error) {
                _callback(error)
              } else {
                console.log('    remove old file')
                drive.files.update({
                  fileId: file.id,
                  removeParents: file.parents.join('.')
                }, _callback)
              }
            })
          }
        }
      })
    }, callback)
  }

})
