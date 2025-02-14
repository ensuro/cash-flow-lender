#!/bin/bash

if [ $# -ne 4 ]; then
    echo "Usage $0 <verifiable-dir> <package> <version> <type>"
    exit 1
fi

VERIFIABLE_DIR=$1
PACKAGE=$2
VERSION=$3
TYPE=$4

if [ "xx$TYPE" != "xxnpm" ]; then
    echo "Only npm accepted - Received $TYPE"
    exit 1
fi

TEMPDIR=`mktemp -d`

FILENAME=`npm pack --quiet --pack-destination $TEMPDIR ${PACKAGE}@${VERSION}`

TARGET_DIR=${VERIFIABLE_DIR}/${PACKAGE}/${VERSION}

if [ -d $TARGET_DIR ]; then
    rm -fR $TARGET_DIR
fi
mkdir -p $TARGET_DIR

tar zxvf $TEMPDIR/$FILENAME --strip 1 -C $TARGET_DIR
