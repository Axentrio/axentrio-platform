CREATE DATABASE axentrio_dev;

\connect axentrio_staging
CREATE EXTENSION IF NOT EXISTS vector;

\connect axentrio_dev
CREATE EXTENSION IF NOT EXISTS vector;
