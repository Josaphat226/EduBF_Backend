# Migrations EduBF

Ces fichiers décrivent la structure complète de la base de données,
dans l'ordre où ils doivent être exécutés (numérotés 001 à 010).

## Recréer la base à partir de zéro

Si tu dois un jour recréer la base de données ailleurs :

```bash
psql "TON_DATABASE_URL" -f 001_admins.sql
psql "TON_DATABASE_URL" -f 002_users.sql
psql "TON_DATABASE_URL" -f 003_documents.sql
psql "TON_DATABASE_URL" -f 004_admin_actions.sql
psql "TON_DATABASE_URL" -f 005_commentaires.sql
psql "TON_DATABASE_URL" -f 006_favoris.sql
psql "TON_DATABASE_URL" -f 007_recommendation_scores.sql
psql "TON_DATABASE_URL" -f 008_reset_tokens.sql
psql "TON_DATABASE_URL" -f 009_sessions.sql
psql "TON_DATABASE_URL" -f 010_user_actions.sql
```

## Règle pour la suite

À partir de maintenant, chaque changement de structure de la base
(nouvelle colonne, nouvelle table...) doit être écrit dans un
nouveau fichier numéroté ici (ex. `011_ajout_note_moyenne.sql`),
en plus d'être appliqué sur la vraie base. Comme ça, ce dossier
reste toujours le reflet exact et à jour de la structure réelle.