---
rel_path: "security/p001-transformers-sharp-package-identities-20261106-v1.json"
updated_at: 1793942062146
_body: "content"
---

{
  "schema": "p001-transformers-native-dependency-package-identities-v1",
  "recordedAt": "2026-11-06T05:14:22.085650+00:00",
  "lockRow": {
    "path": "node_modules/sharp",
    "entry": {
      "version": "0.35.5",
      "resolved": "https://registry.npmjs.org/sharp/-/sharp-0.35.5.tgz",
      "integrity": "sha512-Ywn4OnzGukp7CDMrp08RQ50YKmuwG47brZgIVPTvBaaAfQlRlygrRqSrxdCiL9M+LlzLBiJ68IR1QqvzHyjC7g==",
      "license": "Apache-2.0",
      "dependencies": {
        "@img/colour": "^1.1.0",
        "detect-libc": "^2.1.2",
        "semver": "^7.8.5"
      },
      "engines": {
        "node": ">=20.9.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      },
      "optionalDependencies": {
        "@img/sharp-darwin-arm64": "0.35.5",
        "@img/sharp-darwin-x64": "0.35.5",
        "@img/sharp-freebsd-wasm32": "0.35.5",
        "@img/sharp-libvips-darwin-arm64": "1.3.4",
        "@img/sharp-libvips-darwin-x64": "1.3.4",
        "@img/sharp-libvips-linux-arm": "1.3.4",
        "@img/sharp-libvips-linux-arm64": "1.3.4",
        "@img/sharp-libvips-linux-ppc64": "1.3.4",
        "@img/sharp-libvips-linux-riscv64": "1.3.4",
        "@img/sharp-libvips-linux-s390x": "1.3.4",
        "@img/sharp-libvips-linux-x64": "1.3.4",
        "@img/sharp-libvips-linuxmusl-arm64": "1.3.4",
        "@img/sharp-libvips-linuxmusl-x64": "1.3.4",
        "@img/sharp-linux-arm": "0.35.5",
        "@img/sharp-linux-arm64": "0.35.5",
        "@img/sharp-linux-ppc64": "0.35.5",
        "@img/sharp-linux-riscv64": "0.35.5",
        "@img/sharp-linux-s390x": "0.35.5",
        "@img/sharp-linux-x64": "0.35.5",
        "@img/sharp-linuxmusl-arm64": "0.35.5",
        "@img/sharp-linuxmusl-x64": "0.35.5",
        "@img/sharp-webcontainers-wasm32": "0.35.5",
        "@img/sharp-win32-arm64": "0.35.5",
        "@img/sharp-win32-ia32": "0.35.5",
        "@img/sharp-win32-x64": "0.35.5"
      },
      "peerDependenciesMeta": {
        "@types/node": {
          "optional": true
        }
      }
    }
  },
  "acquisition": {
    "url": "https://registry.npmjs.org/sharp/-/sharp-0.35.5.tgz",
    "bytes": 214749,
    "sha256": "3b6bbbe6b308f5c383938ca4a31926cd5d79c4651ed8c5fda16a97da2014a9ac",
    "integrity": "sha512-Ywn4OnzGukp7CDMrp08RQ50YKmuwG47brZgIVPTvBaaAfQlRlygrRqSrxdCiL9M+LlzLBiJ68IR1QqvzHyjC7g==",
    "matchesRetainedIntegrity": true
  },
  "manifest": {
    "path": "package.json",
    "bytes": 8115,
    "sha256": "ad4a2535d72eb638053a38867b1abf43c328cd1c1dbae5cf4172d498365a8b97",
    "text": "{\n  \"name\": \"sharp\",\n  \"description\": \"High performance Node.js image processing, the fastest module to resize JPEG, PNG, WebP, GIF, AVIF and TIFF images\",\n  \"version\": \"0.35.5\",\n  \"author\": \"Lovell Fuller <npm@lovell.info>\",\n  \"homepage\": \"https://sharp.pixelplumbing.com\",\n  \"contributors\": [\n    \"Pierre Inglebert <pierre.inglebert@gmail.com>\",\n    \"Jonathan Ong <jonathanrichardong@gmail.com>\",\n    \"Chanon Sajjamanochai <chanon.s@gmail.com>\",\n    \"Juliano Julio <julianojulio@gmail.com>\",\n    \"Daniel Gasienica <daniel@gasienica.ch>\",\n    \"Julian Walker <julian@fiftythree.com>\",\n    \"Amit Pitaru <pitaru.amit@gmail.com>\",\n    \"Brandon Aaron <hello.brandon@aaron.sh>\",\n    \"Andreas Lind <andreas@one.com>\",\n    \"Maurus Cuelenaere <mcuelenaere@gmail.com>\",\n    \"Linus Unnebäck <linus@folkdatorn.se>\",\n    \"Victor Mateevitsi <mvictoras@gmail.com>\",\n    \"Alaric Holloway <alaric.holloway@gmail.com>\",\n    \"Bernhard K. Weisshuhn <bkw@codingforce.com>\",\n    \"Chris Riley <criley@primedia.com>\",\n    \"David Carley <dacarley@gmail.com>\",\n    \"John Tobin <john@limelightmobileinc.com>\",\n    \"Kenton Gray <kentongray@gmail.com>\",\n    \"Felix Bünemann <Felix.Buenemann@gmail.com>\",\n    \"Samy Al Zahrani <samyalzahrany@gmail.com>\",\n    \"Chintan Thakkar <lemnisk8@gmail.com>\",\n    \"F. Orlando Galashan <frulo@gmx.de>\",\n    \"Kleis Auke Wolthuizen <info@kleisauke.nl>\",\n    \"Matt Hirsch <mhirsch@media.mit.edu>\",\n    \"Matthias Thoemmes <thoemmes@gmail.com>\",\n    \"Patrick Paskaris <patrick@paskaris.gr>\",\n    \"Jérémy Lal <kapouer@melix.org>\",\n    \"Rahul Nanwani <r.nanwani@gmail.com>\",\n    \"Alice Monday <alice0meta@gmail.com>\",\n    \"Kristo Jorgenson <kristo.jorgenson@gmail.com>\",\n    \"YvesBos <yves_bos@outlook.com>\",\n    \"Guy Maliar <guy@tailorbrands.com>\",\n    \"Nicolas Coden <nicolas@ncoden.fr>\",\n    \"Matt Parrish <matt.r.parrish@gmail.com>\",\n    \"Marcel Bretschneider <marcel.bretschneider@gmail.com>\",\n    \"Matthew McEachen <matthew+github@mceachen.org>\",\n    \"Jarda Kotěšovec <jarda.kotesovec@gmail.com>\",\n    \"Kenric D'Souza <kenric.dsouza@gmail.com>\",\n    \"Oleh Aleinyk <oleg.aleynik@gmail.com>\",\n    \"Marcel Bretschneider <marcel.bretschneider@gmail.com>\",\n    \"Andrea Bianco <andrea.bianco@unibas.ch>\",\n    \"Rik Heywood <rik@rik.org>\",\n    \"Thomas Parisot <hi@oncletom.io>\",\n    \"Nathan Graves <nathanrgraves+github@gmail.com>\",\n    \"Tom Lokhorst <tom@lokhorst.eu>\",\n    \"Espen Hovlandsdal <espen@hovlandsdal.com>\",\n    \"Sylvain Dumont <sylvain.dumont35@gmail.com>\",\n    \"Alun Davies <alun.owain.davies@googlemail.com>\",\n    \"Aidan Hoolachan <ajhoolachan21@gmail.com>\",\n    \"Axel Eirola <axel.eirola@iki.fi>\",\n    \"Freezy <freezy@xbmc.org>\",\n    \"Daiz <taneli.vatanen@gmail.com>\",\n    \"Julian Aubourg <j@ubourg.net>\",\n    \"Keith Belovay <keith@picthrive.com>\",\n    \"Michael B. Klein <mbklein@gmail.com>\",\n    \"Jordan Prudhomme <jordan@raboland.fr>\",\n    \"Ilya Ovdin <iovdin@gmail.com>\",\n    \"Andargor <andargor@yahoo.com>\",\n    \"Paul Neave <paul.neave@gmail.com>\",\n    \"Brendan Kennedy <brenwken@gmail.com>\",\n    \"Brychan Bennett-Odlum <git@brychan.io>\",\n    \"Edward Silverton <e.silverton@gmail.com>\",\n    \"Roman Malieiev <aromaleev@gmail.com>\",\n    \"Tomas Szabo <tomas.szabo@deftomat.com>\",\n    \"Robert O'Rourke <robert@o-rourke.org>\",\n    \"Guillermo Alfonso Varela Chouciño <guillevch@gmail.com>\",\n    \"Christian Flintrup <chr@gigahost.dk>\",\n    \"Manan Jadhav <manan@motionden.com>\",\n    \"Leon Radley <leon@radley.se>\",\n    \"alza54 <alza54@thiocod.in>\",\n    \"Jacob Smith <jacob@frende.me>\",\n    \"Michael Nutt <michael@nutt.im>\",\n    \"Brad Parham <baparham@gmail.com>\",\n    \"Taneli Vatanen <taneli.vatanen@gmail.com>\",\n    \"Joris Dugué <zaruike10@gmail.com>\",\n    \"Chris Banks <christopher.bradley.banks@gmail.com>\",\n    \"Ompal Singh <ompal.hitm09@gmail.com>\",\n    \"Brodan <christopher.hranj@gmail.com>\",\n    \"Ankur Parihar <ankur.github@gmail.com>\",\n    \"Brahim Ait elhaj <brahima@gmail.com>\",\n    \"Mart Jansink <m.jansink@gmail.com>\",\n    \"Lachlan Newman <lachnewman007@gmail.com>\",\n    \"Dennis Beatty <dennis@dcbeatty.com>\",\n    \"Ingvar Stepanyan <me@rreverser.com>\",\n    \"Don Denton <don@happycollision.com>\",\n    \"Dmytro Tiapukhin <cool.gegeg@gmail.com>\",\n    \"Florian Lefebvre <contact@florian-lefebvre.dev>\"\n  ],\n  \"scripts\": {\n    \"build\": \"node install/build.js\",\n    \"build:dist\": \"node scripts/build.mjs\",\n    \"clean\": \"rm -rf src/build/ test/fixtures/output.*\",\n    \"test\": \"npm run lint && npm run test-unit\",\n    \"lint\": \"npm run lint-cpp && npm run lint-js && npm run lint-types && npm run lint-publish\",\n    \"lint-cpp\": \"cpplint --quiet src/*.h src/*.cc\",\n    \"lint-js\": \"biome lint\",\n    \"lint-publish\": \"publint --strict\",\n    \"lint-types\": \"tsd --files ./test/types/sharp.test-d.{cts,mts}\",\n    \"test-leak\": \"./test/leak/leak.sh\",\n    \"test-unit\": \"node --experimental-test-coverage test/unit.mjs\",\n    \"package-from-local-build\": \"node npm/from-local-build.js\",\n    \"package-wasm-wrappers\": \"node npm/wasm-wrappers.js\",\n    \"package-release-notes\": \"node npm/release-notes.js\",\n    \"docs-build\": \"node docs/build.mjs\",\n    \"docs-serve\": \"cd docs && npm start\",\n    \"docs-publish\": \"cd docs && npm run build && npx firebase-tools deploy --project pixelplumbing --only hosting:pixelplumbing-sharp\"\n  },\n  \"type\": \"commonjs\",\n  \"files\": [\n    \"dist\",\n    \"install\",\n    \"lib/index.d.ts\",\n    \"src/*.{cc,h,gyp}\"\n  ],\n  \"main\": \"./dist/index.cjs\",\n  \"module\": \"./dist/index.mjs\",\n  \"types\": \"./dist/index.d.mts\",\n  \"exports\": {\n    \".\": {\n      \"import\": {\n        \"types\": \"./dist/index.d.mts\",\n        \"default\": \"./dist/index.mjs\"\n      },\n      \"require\": {\n        \"types\": \"./dist/index.d.cts\",\n        \"default\": \"./dist/index.cjs\"\n      }\n    }\n  },\n  \"sideEffects\": true,\n  \"repository\": {\n    \"type\": \"git\",\n    \"url\": \"git+https://github.com/lovell/sharp.git\"\n  },\n  \"keywords\": [\n    \"jpeg\",\n    \"png\",\n    \"webp\",\n    \"avif\",\n    \"tiff\",\n    \"gif\",\n    \"svg\",\n    \"jp2\",\n    \"dzi\",\n    \"image\",\n    \"resize\",\n    \"thumbnail\",\n    \"crop\",\n    \"embed\",\n    \"libvips\",\n    \"vips\"\n  ],\n  \"dependencies\": {\n    \"@img/colour\": \"^1.1.0\",\n    \"detect-libc\": \"^2.1.2\",\n    \"semver\": \"^7.8.5\"\n  },\n  \"optionalDependencies\": {\n    \"@img/sharp-darwin-arm64\": \"0.35.5\",\n    \"@img/sharp-darwin-x64\": \"0.35.5\",\n    \"@img/sharp-freebsd-wasm32\": \"0.35.5\",\n    \"@img/sharp-libvips-darwin-arm64\": \"1.3.4\",\n    \"@img/sharp-libvips-darwin-x64\": \"1.3.4\",\n    \"@img/sharp-libvips-linux-arm\": \"1.3.4\",\n    \"@img/sharp-libvips-linux-arm64\": \"1.3.4\",\n    \"@img/sharp-libvips-linux-ppc64\": \"1.3.4\",\n    \"@img/sharp-libvips-linux-riscv64\": \"1.3.4\",\n    \"@img/sharp-libvips-linux-s390x\": \"1.3.4\",\n    \"@img/sharp-libvips-linux-x64\": \"1.3.4\",\n    \"@img/sharp-libvips-linuxmusl-arm64\": \"1.3.4\",\n    \"@img/sharp-libvips-linuxmusl-x64\": \"1.3.4\",\n    \"@img/sharp-linux-arm\": \"0.35.5\",\n    \"@img/sharp-linux-arm64\": \"0.35.5\",\n    \"@img/sharp-linux-ppc64\": \"0.35.5\",\n    \"@img/sharp-linux-riscv64\": \"0.35.5\",\n    \"@img/sharp-linux-s390x\": \"0.35.5\",\n    \"@img/sharp-linux-x64\": \"0.35.5\",\n    \"@img/sharp-linuxmusl-arm64\": \"0.35.5\",\n    \"@img/sharp-linuxmusl-x64\": \"0.35.5\",\n    \"@img/sharp-webcontainers-wasm32\": \"0.35.5\",\n    \"@img/sharp-win32-arm64\": \"0.35.5\",\n    \"@img/sharp-win32-ia32\": \"0.35.5\",\n    \"@img/sharp-win32-x64\": \"0.35.5\"\n  },\n  \"peerDependenciesMeta\": {\n    \"@types/node\": {\n      \"optional\": true\n    }\n  },\n  \"devDependencies\": {\n    \"@biomejs/biome\": \"^2.5.14\",\n    \"@cpplint/cli\": \"^0.1.0\",\n    \"@emnapi/runtime\": \"^1.11.3\",\n    \"@img/sharp-libvips-dev\": \"1.3.4\",\n    \"@img/sharp-libvips-dev-wasm32\": \"1.3.4\",\n    \"@img/sharp-libvips-win32-arm64\": \"1.3.4\",\n    \"@img/sharp-libvips-win32-ia32\": \"1.3.4\",\n    \"@img/sharp-libvips-win32-x64\": \"1.3.4\",\n    \"@types/node\": \"*\",\n    \"emnapi\": \"^1.11.3\",\n    \"exif-reader\": \"^2.0.3\",\n    \"icc\": \"^4.0.0\",\n    \"node-addon-api\": \"^8.9.2\",\n    \"node-gyp\": \"^12.4.0\",\n    \"publint\": \"^0.3.24\",\n    \"tar-fs\": \"^3.1.3\",\n    \"tsd\": \"^0.33.0\",\n    \"yauzl\": \"^3.4.0\"\n  },\n  \"license\": \"Apache-2.0\",\n  \"engines\": {\n    \"node\": \">=20.9.0\"\n  },\n  \"config\": {\n    \"libvips\": \">=8.18.7\"\n  },\n  \"funding\": {\n    \"url\": \"https://opencollective.com/libvips\"\n  }\n}\n"
  },
  "entryIdentities": [
    {
      "path": "dist/index.cjs",
      "fields": [
        "main",
        "exports...require.default"
      ],
      "bytes": 620,
      "sha256": "d69f275bc49fcd2a6188b26b35c986d4db32a1b008653fef88adb4598688232a",
      "sourceText": "/*!\n  Copyright 2013 Lovell Fuller and others.\n  SPDX-License-Identifier: Apache-2.0\n*/\n\nconst Sharp = require('./constructor.cjs');\nconst input = require('./input.cjs');\nconst resize = require('./resize.cjs');\nconst composite = require('./composite.cjs');\nconst operation = require('./operation.cjs');\nconst colour = require('./colour.cjs');\nconst channel = require('./channel.cjs');\nconst output = require('./output.cjs');\nconst utility = require('./utility.cjs');\n\ninput(Sharp);\nresize(Sharp);\ncomposite(Sharp);\noperation(Sharp);\ncolour(Sharp);\nchannel(Sharp);\noutput(Sharp);\nutility(Sharp);\n\nmodule.exports = Sharp;\n"
    },
    {
      "path": "dist/index.mjs",
      "fields": [
        "module",
        "exports...import.default"
      ],
      "bytes": 573,
      "sha256": "0e8f955c68a1b0bccf0ba5343c924dbfa6a46a76a0d491ec27fe6b328311363e",
      "sourceText": "/*!\n  Copyright 2013 Lovell Fuller and others.\n  SPDX-License-Identifier: Apache-2.0\n*/\n\nimport Sharp from './constructor.mjs';\nimport input from './input.mjs';\nimport resize from './resize.mjs';\nimport composite from './composite.mjs';\nimport operation from './operation.mjs';\nimport colour from './colour.mjs';\nimport channel from './channel.mjs';\nimport output from './output.mjs';\nimport utility from './utility.mjs';\n\ninput(Sharp);\nresize(Sharp);\ncomposite(Sharp);\noperation(Sharp);\ncolour(Sharp);\nchannel(Sharp);\noutput(Sharp);\nutility(Sharp);\n\nexport default Sharp;\n"
    },
    {
      "path": "dist/index.d.mts",
      "fields": [
        "exports...import.types"
      ],
      "bytes": 87987,
      "sha256": "b837d41bb8d39398690458f45cc445160dad36ec0db5ba0463d114e560d49d85",
      "sourceText": null
    },
    {
      "path": "dist/index.d.cts",
      "fields": [
        "exports...require.types"
      ],
      "bytes": 92885,
      "sha256": "24adc1ebbf6b05fc1434083b899b9ffd7edda0aa85ac0123d7ddb4ff860e5884",
      "sourceText": null
    }
  ],
  "candidateExecution": false,
  "installedRuntimeIdentityProven": false,
  "captureCommand": "python3 - <<'PY'\n\nimport urllib.request,tarfile,io,hashlib,base64,json,posixpath,datetime\nrow=json.loads(\"{\\\"path\\\":\\\"node_modules/sharp\\\",\\\"entry\\\":{\\\"version\\\":\\\"0.35.5\\\",\\\"resolved\\\":\\\"https://registry.npmjs.org/sharp/-/sharp-0.35.5.tgz\\\",\\\"integrity\\\":\\\"sha512-Ywn4OnzGukp7CDMrp08RQ50YKmuwG47brZgIVPTvBaaAfQlRlygrRqSrxdCiL9M+LlzLBiJ68IR1QqvzHyjC7g==\\\",\\\"license\\\":\\\"Apache-2.0\\\",\\\"dependencies\\\":{\\\"@img/colour\\\":\\\"^1.1.0\\\",\\\"detect-libc\\\":\\\"^2.1.2\\\",\\\"semver\\\":\\\"^7.8.5\\\"},\\\"engines\\\":{\\\"node\\\":\\\">=20.9.0\\\"},\\\"funding\\\":{\\\"url\\\":\\\"https://opencollective.com/libvips\\\"},\\\"optionalDependencies\\\":{\\\"@img/sharp-darwin-arm64\\\":\\\"0.35.5\\\",\\\"@img/sharp-darwin-x64\\\":\\\"0.35.5\\\",\\\"@img/sharp-freebsd-wasm32\\\":\\\"0.35.5\\\",\\\"@img/sharp-libvips-darwin-arm64\\\":\\\"1.3.4\\\",\\\"@img/sharp-libvips-darwin-x64\\\":\\\"1.3.4\\\",\\\"@img/sharp-libvips-linux-arm\\\":\\\"1.3.4\\\",\\\"@img/sharp-libvips-linux-arm64\\\":\\\"1.3.4\\\",\\\"@img/sharp-libvips-linux-ppc64\\\":\\\"1.3.4\\\",\\\"@img/sharp-libvips-linux-riscv64\\\":\\\"1.3.4\\\",\\\"@img/sharp-libvips-linux-s390x\\\":\\\"1.3.4\\\",\\\"@img/sharp-libvips-linux-x64\\\":\\\"1.3.4\\\",\\\"@img/sharp-libvips-linuxmusl-arm64\\\":\\\"1.3.4\\\",\\\"@img/sharp-libvips-linuxmusl-x64\\\":\\\"1.3.4\\\",\\\"@img/sharp-linux-arm\\\":\\\"0.35.5\\\",\\\"@img/sharp-linux-arm64\\\":\\\"0.35.5\\\",\\\"@img/sharp-linux-ppc64\\\":\\\"0.35.5\\\",\\\"@img/sharp-linux-riscv64\\\":\\\"0.35.5\\\",\\\"@img/sharp-linux-s390x\\\":\\\"0.35.5\\\",\\\"@img/sharp-linux-x64\\\":\\\"0.35.5\\\",\\\"@img/sharp-linuxmusl-arm64\\\":\\\"0.35.5\\\",\\\"@img/sharp-linuxmusl-x64\\\":\\\"0.35.5\\\",\\\"@img/sharp-webcontainers-wasm32\\\":\\\"0.35.5\\\",\\\"@img/sharp-win32-arm64\\\":\\\"0.35.5\\\",\\\"@img/sharp-win32-ia32\\\":\\\"0.35.5\\\",\\\"@img/sharp-win32-x64\\\":\\\"0.35.5\\\"},\\\"peerDependenciesMeta\\\":{\\\"@types/node\\\":{\\\"optional\\\":true}}}}\");e=row['entry']\nb=urllib.request.urlopen(e['resolved'],timeout=20).read()\nassert 'sha512-'+base64.b64encode(hashlib.sha512(b).digest()).decode()==e['integrity']\nt=tarfile.open(fileobj=io.BytesIO(b),mode='r:gz')\nmb=t.extractfile('package/package.json').read();m=json.loads(mb)\nassert m['version']==e['version']\ntargets=[]\ndef add(v,field):\n if isinstance(v,str) and v.startswith(('./','dist/','lib/','index.')):targets.append((field,v.removeprefix('./')))\n elif isinstance(v,dict):\n  for k,x in v.items():add(x,field+'.'+k)\n elif isinstance(v,list):\n  for i,x in enumerate(v):add(x,field+'.'+str(i))\nfor key in ['main','module','exports']:add(m.get(key),key)\nentries=[]\nfor p in dict.fromkeys(v for _,v in targets):\n f=t.extractfile('package/'+p);data=f.read()\n entries.append({'path':p,'fields':[k for k,v in targets if v==p],'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'sourceText':data.decode() if p.endswith(('.js','.mjs','.cjs')) and len(data)<5000 else None})\nrecord={'schema':'p001-transformers-native-dependency-package-identities-v1','recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'lockRow':row,'acquisition':{'url':e['resolved'],'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'integrity':e['integrity'],'matchesRetainedIntegrity':True},'manifest':{'path':'package.json','bytes':len(mb),'sha256':hashlib.sha256(mb).hexdigest(),'text':mb.decode()},'entryIdentities':entries,'candidateExecution':False,'installedRuntimeIdentityProven':False}\nout=json.dumps(record);assert len(out)<14000,len(out);print(out)\n\nPY"
}
