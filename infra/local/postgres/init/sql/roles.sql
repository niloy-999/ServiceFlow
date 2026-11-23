\getenv migrator_password SERVICEFLOW_MIGRATOR_PASSWORD
SELECT format('CREATE ROLE serviceflow_migrator LOGIN PASSWORD %L', :'migrator_password')
\gexec
ALTER ROLE serviceflow_migrator SET timezone TO 'UTC';
\getenv app_password SERVICEFLOW_APP_PASSWORD
SELECT format('CREATE ROLE serviceflow_app LOGIN PASSWORD %L', :'app_password')
\gexec
ALTER ROLE serviceflow_app SET timezone TO 'UTC';
