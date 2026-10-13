// Écriture atomique : on écrit dans un fichier temporaire puis on le renomme, un plantage ne laisse jamais un fichier à moitié écrit.
const fs = require('fs');
const path = require('path');
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}
module.exports = { writeJsonAtomic };
