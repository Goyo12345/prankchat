# Langues de PrankChat

Le site et l'interface Windows proposent français, anglais, allemand, espagnol,
italien et portugais. La langue du navigateur/système est utilisée au premier
lancement (anglais si elle n'est pas disponible). Le menu mémorise ensuite le
choix dans le stockage local de chaque installation ou navigateur.

Les textes sont dans `translations.js`, dans l'ordre `fr, en, de, es, it, pt`.
Les attributs `data-i18n`, `data-i18n-title` et `data-i18n-placeholder` relient
les éléments à ces clés. Pour un texte qui change pendant l'utilisation,
utiliser `I18n.text(elementOuId, cle, valeurs)` : il sera retraduit lors du
changement de langue. Les paramètres `{remaining}` et `{limit}` restent des
données, pas du HTML. Les textes et médias envoyés par les utilisateurs ne sont
pas traduits.

Les CGU restent en français et leur lien l'indique. Les pages hébergées par
Stripe sont gérées par Stripe. Les interfaces OBS et overlay affichent le
contenu envoyé, sans menu de langue superposé à la vidéo.

Validation : `node --test updates.test.js`, puis
`electron i18n.electron-test.cjs`. Le second test utilise des fenêtres invisibles,
un profil temporaire et bloque le réseau. Il vérifie les six langues, leur
persistance, le quota, Premium et la conservation des saisies.

Compilation Windows : `npm run build:desktop -- --config.directories.output=dist/1.3.0`.

Railway utilise `npm run build` pour vérifier le serveur, puis `npm start` pour
le lancer. Le site sert directement ses fichiers HTML, CSS et JavaScript : il
ne doit pas lancer Electron ni publier un installateur depuis Railway.
