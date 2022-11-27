FROM ruby:2.7
RUN set -x && curl -sS https://dl.yarnpkg.com/debian/pubkey.gpg | apt-key add - && \
    echo 'deb http://dl.yarnpkg.com/debian/ stable main' > /etc/apt/sources.list.d/yarn.list
WORKDIR /usr/src/app
COPY . /usr/src/app
RUN apt-get update -qq && apt-get install -y nodejs postgresql-client yarn
COPY Gemfile /usr/src/app/Gemfile
COPY Gemfile.lock /usr/src/app/Gemfile.lock
RUN bundle install

EXPOSE 3000

ENV RAILS_ENV=production

RUN chmod +x /usr/src/app/entrypoint.sh
ENTRYPOINT ["/usr/src/app/entrypoint.sh"]

VOLUME /usr/src/app/

CMD /bin/sh -c "bundle exec rails s -p 3000 -e production"