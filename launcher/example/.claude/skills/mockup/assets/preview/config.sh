#!/usr/bin/env bash
# The mockup as a preview of its own, run by the generic `preview` engine from inside
# <frontend>/.mockup/. mockup.sh init fills PREVIEW_PROJECT from the frontend's name.
PREVIEW_PROJECT="__PROJECT__ mockup"
PREVIEW_DESC="${PREVIEW_DESC:-UI mockup}"
PREVIEW_COMPOSE_FILE="docker-compose.yml"
PREVIEW_COMPOSE_PROJECT_PREFIX="mk"
PREVIEW_LABEL_SERVICE="web"
PREVIEW_SERVE_TARGET="127.0.0.1:$PREVIEW_PORT_1"
