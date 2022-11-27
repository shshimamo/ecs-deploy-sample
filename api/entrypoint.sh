#!/usr/bin/env bash
set -e

rm -f /usr/src/app/tmp/pids/server.pid

#bundle exec rails db:create RAILS_ENV=production
bundle exec rails db:migrate RAILS_ENV=production

exec "$@"