CC ?= gcc
CFLAGS ?= -O2 -Wall -Wextra
PKGS := gtk+-3.0 webkit2gtk-4.1

all: scribe

scribe: main.c
	$(CC) $(CFLAGS) -o $@ $< $$(pkg-config --cflags --libs $(PKGS))

clean:
	rm -f scribe
