CC ?= gcc
PKG_CONFIG ?= pkg-config
CFLAGS ?= -O2 -Wall -Wextra
GTK_CFLAGS := $(shell $(PKG_CONFIG) --cflags gtk4 webkitgtk-6.0 2>/dev/null)
GTK_LIBS := $(shell $(PKG_CONFIG) --libs gtk4 webkitgtk-6.0 2>/dev/null)

all: scribe

scribe: main.c
	$(CC) $(CFLAGS) $(GTK_CFLAGS) -o $@ $< $(GTK_LIBS) -lpthread

clean:
	rm -f scribe

.PHONY: all clean
