# Statistiques publiques des abonnements

URL après déploiement : https://prankchat-production.up.railway.app/stats

Accès public sans identifiant ni mot de passe, conformément au choix du propriétaire. Aucune variable ADMIN_STATS_PASSWORD nécessaire. Déployer les modifications serveur pour activer la page.

La page utilise STRIPE_SECRET_KEY et STRIPE_PRICE_ID déjà configurés côté serveur. Elle affiche uniquement des compteurs agrégés, jamais les identifiants Stripe, noms, emails ou moyens de paiement. Les clés restent côté serveur.

Les clients actifs sont dédupliqués ; essais, impayés et résiliations programmées sont séparés. Le statut actif ne garantit pas un encaissement (remises possibles). Utiliser la clé Stripe du mode réel pour les vrais abonnements. Pagination automatique ; une erreur Stripe est affichée comme une erreur, jamais comme zéro client.

Vérification : node --test admin-stats.test.js ; node --check server.js.
