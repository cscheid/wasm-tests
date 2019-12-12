all: lint

lint:
	./node_modules/.bin/eslint main.js

lint-fix:
	./node_modules/.bin/eslint --fix main.js

install-deps:
	npm install eslint eslint-config-google


