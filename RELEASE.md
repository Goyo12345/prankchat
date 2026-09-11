# Publier une mise à jour PrankChat

1. Augmenter `version` dans package.json et package-lock.json (ex. 1.2.1).
2. Exécuter `node --test updates.test.js`, puis `npm run build -- --publish never`.
3. Créer une release GitHub avec le tag correspondant (ex. v1.2.1).
4. Joindre les trois fichiers du même build :
   - dist/PrankChat-Setup.exe
   - dist/PrankChat-Setup.exe.blockmap
   - dist/latest.yml
5. Publier comme dernière release stable, après la fin des trois uploads.

Ne pas modifier un installateur après génération de latest.yml : ce fichier
contient sa taille et son empreinte SHA-512. Le site conserve son lien
releases/latest/download/PrankChat-Setup.exe.

Les versions antérieures à 1.2.0 nécessitent une installation manuelle unique.
À partir de 1.2.0, les vérifications ont lieu au démarrage et toutes les six
heures. Une mise à jour téléchargée propose un redémarrage, sans l'imposer.
Si l'utilisateur choisit Plus tard, elle sera reproposée au prochain lancement.

yt-dlp est vérifié au démarrage dans une copie temporaire du dossier utilisateur.
Sa mise à jour stable officielle est validée avant d'être utilisée ; les
téléchargements déjà lancés et la copie livrée avec l'app restent intacts.
Les anciennes copies du cache sont conservées pour ne pas interrompre les
processus qui pourraient encore les utiliser.
