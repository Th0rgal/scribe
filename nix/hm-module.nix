{ config, lib, pkgs, ... }:

let
  cfg = config.programs.scribe;
in
{
  options.programs.scribe = {
    enable = lib.mkEnableOption "Scribe Markdown, LaTeX, and Voice Notes desktop app";

    defaultNotesDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.home.homeDirectory}/Notes";
      description = "Default directory for local Markdown and voice notes.";
    };

    hindsight = {
      apiUrl = lib.mkOption {
        type = lib.types.str;
        default = "https://memory.thomas.md";
        description = "Hindsight API base URL.";
      };
      bank = lib.mkOption {
        type = lib.types.str;
        default = "thomas";
        description = "Hindsight bank ID where Scribe notes are automatically synced.";
      };
      notesFolder = lib.mkOption {
        type = lib.types.str;
        default = "scribe";
        description = "Dedicated folder/namespace prefix inside the Hindsight bank.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    home.sessionVariables = {
      SCRIBE_DEFAULT_NOTES_DIR = cfg.defaultNotesDir;
      HINDSIGHT_API_URL = lib.mkDefault cfg.hindsight.apiUrl;
      HINDSIGHT_BANK_ID = lib.mkDefault cfg.hindsight.bank;
      SCRIBE_HINDSIGHT_FOLDER = cfg.hindsight.notesFolder;
    };
  };
}
