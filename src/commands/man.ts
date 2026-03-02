import type { Command, CommandContext } from './index';
import { parseArgs } from './flags';

// Bold: \x1b[1m, Underline: \x1b[4m, Reset: \x1b[0m
const B = '\x1b[1m';
const U = '\x1b[4m';
const R = '\x1b[0m';

/** Curated man pages for top commands */
const manPages: Record<string, string> = {
  ls: `${B}LS(1)${R}                        Shiro Manual                       ${B}LS(1)${R}

${B}NAME${R}
       ls - list directory contents

${B}SYNOPSIS${R}
       ${B}ls${R} [${U}OPTION${R}]... [${U}FILE${R}]...

${B}DESCRIPTION${R}
       List information about the FILEs (the current directory by default).

       ${B}-a${R}, ${B}--all${R}
              do not ignore entries starting with .

       ${B}-l${R}     use a long listing format

       ${B}-R${R}, ${B}--recursive${R}
              list subdirectories recursively

       ${B}-h${R}, ${B}--human-readable${R}
              with -l, print sizes in human readable format

       ${B}-t${R}     sort by modification time, newest first

       ${B}-r${R}     reverse order while sorting

       ${B}-S${R}     sort by file size, largest first

       ${B}-1${R}     list one file per line
`,

  cat: `${B}CAT(1)${R}                       Shiro Manual                      ${B}CAT(1)${R}

${B}NAME${R}
       cat - concatenate files and print on standard output

${B}SYNOPSIS${R}
       ${B}cat${R} [${U}OPTION${R}]... [${U}FILE${R}]...

${B}DESCRIPTION${R}
       Concatenate FILE(s) to standard output. With no FILE, read stdin.

       ${B}-n${R}     number all output lines

       ${B}-b${R}     number nonempty output lines (overrides -n)

       ${B}-s${R}     suppress repeated empty output lines

       ${B}-E${R}     display $ at end of each line
`,

  grep: `${B}GREP(1)${R}                      Shiro Manual                     ${B}GREP(1)${R}

${B}NAME${R}
       grep - print lines that match patterns

${B}SYNOPSIS${R}
       ${B}grep${R} [${U}OPTION${R}]... ${U}PATTERN${R} [${U}FILE${R}]...

${B}DESCRIPTION${R}
       grep searches for PATTERN in each FILE. By default, grep prints
       the matching lines.

       ${B}-i${R}, ${B}--ignore-case${R}
              ignore case distinctions in patterns and data

       ${B}-v${R}, ${B}--invert-match${R}
              select non-matching lines

       ${B}-c${R}, ${B}--count${R}
              print a count of matching lines

       ${B}-n${R}, ${B}--line-number${R}
              prefix each line with its line number

       ${B}-r${R}, ${B}--recursive${R}
              read all files under each directory recursively

       ${B}-l${R}, ${B}--files-with-matches${R}
              print only names of FILEs with matches

       ${B}-w${R}, ${B}--word-regexp${R}
              match only whole words

       ${B}-E${R}, ${B}--extended-regexp${R}
              interpret PATTERN as an extended regular expression

       ${B}-o${R}, ${B}--only-matching${R}
              show only the part of a line matching PATTERN

       ${B}-A${R} ${U}NUM${R}
              print NUM lines of trailing context

       ${B}-B${R} ${U}NUM${R}
              print NUM lines of leading context

       ${B}-C${R} ${U}NUM${R}
              print NUM lines of output context

${B}EXAMPLES${R}
       grep -rn "TODO" src/
              Search for TODO in all files under src/

       echo "hello world" | grep -o "world"
              Extract matching portion only

       grep -c "error" log.txt
              Count error occurrences
`,

  sed: `${B}SED(1)${R}                       Shiro Manual                      ${B}SED(1)${R}

${B}NAME${R}
       sed - stream editor for filtering and transforming text

${B}SYNOPSIS${R}
       ${B}sed${R} [${U}OPTION${R}]... ${U}SCRIPT${R} [${U}FILE${R}]...

${B}DESCRIPTION${R}
       Sed reads input line by line, applies SCRIPT commands, and
       writes the result to standard output.

       ${B}-n${R}     suppress automatic printing of pattern space

       ${B}-i${R}     edit files in place

       ${B}-e${R} ${U}script${R}
              add the script to the commands to be executed

${B}COMMANDS${R}
       ${B}s/${R}${U}regexp${R}${B}/${R}${U}replacement${R}${B}/${R}${U}flags${R}
              Substitute regexp with replacement. Flags: g (global),
              p (print), i (case-insensitive), number (nth occurrence).

       ${B}d${R}     Delete pattern space.

       ${B}p${R}     Print pattern space.

       ${B}q${R}     Quit.

${B}EXAMPLES${R}
       sed 's/old/new/g' file.txt
              Replace all occurrences of old with new

       sed -n '10,20p' file.txt
              Print lines 10 through 20
`,

  awk: `${B}AWK(1)${R}                       Shiro Manual                      ${B}AWK(1)${R}

${B}NAME${R}
       awk - pattern scanning and text processing language

${B}SYNOPSIS${R}
       ${B}awk${R} [${U}OPTION${R}]... ${U}PROGRAM${R} [${U}FILE${R}]...

${B}DESCRIPTION${R}
       Awk scans each input line for patterns and performs actions.

       ${B}-F${R} ${U}sep${R}
              set field separator (default: whitespace)

${B}BUILT-IN VARIABLES${R}
       ${B}NR${R}     current record number
       ${B}NF${R}     number of fields in current record
       ${B}$0${R}     entire current record
       ${B}$1..$N${R} individual fields

${B}EXAMPLES${R}
       awk '{print $1}' file.txt
              Print first field of each line

       awk -F: '{print $1, $3}' /etc/passwd
              Print username and UID

       awk 'NR==5,NR==10' file.txt
              Print lines 5 through 10
`,

  find: `${B}FIND(1)${R}                      Shiro Manual                     ${B}FIND(1)${R}

${B}NAME${R}
       find - search for files in a directory hierarchy

${B}SYNOPSIS${R}
       ${B}find${R} [${U}path${R}] [${U}expression${R}]

${B}DESCRIPTION${R}
       Search for files matching criteria under the given path.

       ${B}-name${R} ${U}pattern${R}
              match filename by glob pattern

       ${B}-type${R} ${U}c${R}
              file type: f (regular file), d (directory)

       ${B}-maxdepth${R} ${U}N${R}
              descend at most N levels

       ${B}-exec${R} ${U}command${R} {} \\;
              execute command on each match

${B}EXAMPLES${R}
       find . -name "*.ts" -type f
              Find all TypeScript files

       find /tmp -name "*.log" -exec rm {} \\;
              Delete all log files in /tmp
`,

  cd: `${B}CD(1)${R}                        Shiro Manual                       ${B}CD(1)${R}

${B}NAME${R}
       cd - change the working directory

${B}SYNOPSIS${R}
       ${B}cd${R} [${U}dir${R}]

${B}DESCRIPTION${R}
       Change the current directory to ${U}dir${R}. With no arguments, changes
       to the home directory (/home/user).

       ${B}cd -${R}   change to previous directory (OLDPWD)
       ${B}cd ..${R}  change to parent directory
`,

  echo: `${B}ECHO(1)${R}                      Shiro Manual                     ${B}ECHO(1)${R}

${B}NAME${R}
       echo - display a line of text

${B}SYNOPSIS${R}
       ${B}echo${R} [${U}OPTION${R}]... [${U}STRING${R}]...

${B}DESCRIPTION${R}
       Echo the STRING(s) to standard output.

       ${B}-n${R}     do not output the trailing newline
       ${B}-e${R}     enable interpretation of backslash escapes
       ${B}-E${R}     disable interpretation of backslash escapes (default)

${B}ESCAPE SEQUENCES${R}
       \\n     new line
       \\t     horizontal tab
       \\\\     backslash
       \\0nnn  octal value
`,

  cp: `${B}CP(1)${R}                        Shiro Manual                       ${B}CP(1)${R}

${B}NAME${R}
       cp - copy files and directories

${B}SYNOPSIS${R}
       ${B}cp${R} [${U}OPTION${R}]... ${U}SOURCE${R} ${U}DEST${R}

${B}DESCRIPTION${R}
       Copy SOURCE to DEST, or multiple SOURCE(s) to DIRECTORY.

       ${B}-r${R}, ${B}-R${R}
              copy directories recursively

       ${B}-f${R}     force overwrite
`,

  mv: `${B}MV(1)${R}                        Shiro Manual                       ${B}MV(1)${R}

${B}NAME${R}
       mv - move (rename) files

${B}SYNOPSIS${R}
       ${B}mv${R} [${U}OPTION${R}]... ${U}SOURCE${R} ${U}DEST${R}

${B}DESCRIPTION${R}
       Rename SOURCE to DEST, or move SOURCE(s) to DIRECTORY.

       ${B}-f${R}     do not prompt before overwriting
`,

  rm: `${B}RM(1)${R}                        Shiro Manual                       ${B}RM(1)${R}

${B}NAME${R}
       rm - remove files or directories

${B}SYNOPSIS${R}
       ${B}rm${R} [${U}OPTION${R}]... [${U}FILE${R}]...

${B}DESCRIPTION${R}
       Remove (unlink) the FILE(s).

       ${B}-f${R}     ignore nonexistent files, never prompt
       ${B}-r${R}, ${B}-R${R}
              remove directories and their contents recursively
`,

  mkdir: `${B}MKDIR(1)${R}                     Shiro Manual                   ${B}MKDIR(1)${R}

${B}NAME${R}
       mkdir - make directories

${B}SYNOPSIS${R}
       ${B}mkdir${R} [${U}OPTION${R}]... ${U}DIRECTORY${R}...

${B}DESCRIPTION${R}
       Create the DIRECTORY(ies), if they do not already exist.

       ${B}-p${R}     make parent directories as needed
`,

  head: `${B}HEAD(1)${R}                      Shiro Manual                     ${B}HEAD(1)${R}

${B}NAME${R}
       head - output the first part of files

${B}SYNOPSIS${R}
       ${B}head${R} [${U}OPTION${R}]... [${U}FILE${R}]...

${B}DESCRIPTION${R}
       Print the first 10 lines of each FILE to standard output.

       ${B}-n${R} ${U}NUM${R}
              print the first NUM lines instead of 10

       ${B}-c${R} ${U}NUM${R}
              print the first NUM bytes
`,

  tail: `${B}TAIL(1)${R}                      Shiro Manual                     ${B}TAIL(1)${R}

${B}NAME${R}
       tail - output the last part of files

${B}SYNOPSIS${R}
       ${B}tail${R} [${U}OPTION${R}]... [${U}FILE${R}]...

${B}DESCRIPTION${R}
       Print the last 10 lines of each FILE to standard output.

       ${B}-n${R} ${U}NUM${R}
              output the last NUM lines instead of 10

       ${B}-c${R} ${U}NUM${R}
              output the last NUM bytes

       ${B}-f${R}     output appended data as the file grows
`,

  wc: `${B}WC(1)${R}                        Shiro Manual                       ${B}WC(1)${R}

${B}NAME${R}
       wc - print newline, word, and byte counts

${B}SYNOPSIS${R}
       ${B}wc${R} [${U}OPTION${R}]... [${U}FILE${R}]...

${B}DESCRIPTION${R}
       Print newline, word, and byte counts for each FILE.

       ${B}-l${R}     print the newline counts
       ${B}-w${R}     print the word counts
       ${B}-c${R}     print the byte counts
       ${B}-m${R}     print the character counts
`,

  sort: `${B}SORT(1)${R}                      Shiro Manual                     ${B}SORT(1)${R}

${B}NAME${R}
       sort - sort lines of text files

${B}SYNOPSIS${R}
       ${B}sort${R} [${U}OPTION${R}]... [${U}FILE${R}]...

${B}DESCRIPTION${R}
       Write sorted concatenation of all FILE(s) to standard output.

       ${B}-r${R}     reverse the result of comparisons
       ${B}-n${R}     compare according to string numerical value
       ${B}-u${R}     output only unique lines
       ${B}-k${R} ${U}POS${R}
              sort via a key starting at POS
       ${B}-t${R} ${U}SEP${R}
              use SEP as the field separator
`,

  uniq: `${B}UNIQ(1)${R}                      Shiro Manual                     ${B}UNIQ(1)${R}

${B}NAME${R}
       uniq - report or omit repeated lines

${B}SYNOPSIS${R}
       ${B}uniq${R} [${U}OPTION${R}]... [${U}INPUT${R} [${U}OUTPUT${R}]]

${B}DESCRIPTION${R}
       Filter adjacent matching lines from INPUT, writing to OUTPUT.

       ${B}-c${R}     prefix lines by the number of occurrences
       ${B}-d${R}     only print duplicate lines
       ${B}-u${R}     only print unique lines
       ${B}-i${R}     ignore differences in case
`,

  chmod: `${B}CHMOD(1)${R}                     Shiro Manual                   ${B}CHMOD(1)${R}

${B}NAME${R}
       chmod - change file mode bits

${B}SYNOPSIS${R}
       ${B}chmod${R} [${U}OPTION${R}]... ${U}MODE${R} ${U}FILE${R}...

${B}DESCRIPTION${R}
       Change the file mode (permissions) of each FILE.

       ${B}-R${R}     change files and directories recursively

${B}MODE${R}
       Octal (e.g. 755) or symbolic (e.g. u+x, go-w).
`,

  curl: `${B}CURL(1)${R}                      Shiro Manual                     ${B}CURL(1)${R}

${B}NAME${R}
       curl - transfer a URL

${B}SYNOPSIS${R}
       ${B}curl${R} [${U}OPTION${R}]... ${U}URL${R}

${B}DESCRIPTION${R}
       Transfer data from or to a server using HTTP/HTTPS.

       ${B}-o${R} ${U}file${R}
              write output to file instead of stdout

       ${B}-s${R}     silent mode

       ${B}-H${R} ${U}header${R}
              pass custom header (e.g. "Authorization: Bearer token")

       ${B}-X${R} ${U}method${R}
              specify request method (GET, POST, PUT, DELETE)

       ${B}-d${R} ${U}data${R}
              send data in POST request body

${B}EXAMPLES${R}
       curl https://api.example.com/data
              Fetch URL content

       curl -X POST -d '{"key":"val"}' -H "Content-Type: application/json" url
              POST JSON data
`,

  git: `${B}GIT(1)${R}                       Shiro Manual                      ${B}GIT(1)${R}

${B}NAME${R}
       git - distributed version control system

${B}SYNOPSIS${R}
       ${B}git${R} ${U}command${R} [${U}args${R}]

${B}DESCRIPTION${R}
       Git is a version control system for tracking changes in files.
       Shiro implements a subset of git commands using isomorphic-git.

${B}COMMANDS${R}
       ${B}init${R}       Create an empty git repository
       ${B}clone${R}      Clone a repository
       ${B}add${R}        Add file contents to the index
       ${B}commit${R}     Record changes to the repository
       ${B}status${R}     Show the working tree status
       ${B}log${R}        Show commit logs
       ${B}diff${R}       Show changes between commits
       ${B}branch${R}     List, create, or delete branches
       ${B}checkout${R}   Switch branches
       ${B}push${R}       Update remote refs
       ${B}pull${R}       Fetch and integrate with remote
`,

  vi: `${B}VI(1)${R}                        Shiro Manual                       ${B}VI(1)${R}

${B}NAME${R}
       vi - screen-oriented text editor

${B}SYNOPSIS${R}
       ${B}vi${R} [${U}file${R}]

${B}DESCRIPTION${R}
       Visual text editor with modal editing (normal, insert, command modes).

${B}NORMAL MODE${R}
       ${B}i${R}      enter insert mode
       ${B}a${R}      append after cursor
       ${B}o${R}      open new line below
       ${B}dd${R}     delete line
       ${B}yy${R}     yank (copy) line
       ${B}p${R}      paste
       ${B}u${R}      undo
       ${B}/${R}      search forward
       ${B}:w${R}     save
       ${B}:q${R}     quit
       ${B}:wq${R}    save and quit
`,

  less: `${B}LESS(1)${R}                      Shiro Manual                     ${B}LESS(1)${R}

${B}NAME${R}
       less - view file contents with pagination

${B}SYNOPSIS${R}
       ${B}less${R} [${U}OPTION${R}]... [${U}FILE${R}]

${B}DESCRIPTION${R}
       Less is a pager: it displays text one screenful at a time.

       ${B}-N${R}     show line numbers
       ${B}-R${R}     pass ANSI color codes through
       ${B}-S${R}     chop long lines instead of wrapping
       ${B}-F${R}     quit if content fits on one screen

${B}KEYS${R}
       ${B}q${R}          quit
       ${B}j${R}/↓        scroll down one line
       ${B}k${R}/↑        scroll up one line
       ${B}Space${R}/f    page down
       ${B}b${R}          page up
       ${B}g${R}          go to top
       ${B}G${R}          go to bottom
       ${B}/${R}${U}pattern${R}  search forward
       ${B}n${R}          next search match
       ${B}N${R}          previous search match
`,

  speak: `${B}SPEAK(1)${R}                     Shiro Manual                   ${B}SPEAK(1)${R}

${B}NAME${R}
       speak - text-to-speech via browser SpeechSynthesis

${B}SYNOPSIS${R}
       ${B}speak${R} [${U}OPTION${R}]... [${U}TEXT${R}]

${B}DESCRIPTION${R}
       Convert text to speech using the browser's SpeechSynthesis API.
       Text can be provided as arguments or piped via stdin.

       ${B}--list${R}
              list available voices

       ${B}--stop${R}
              cancel any ongoing speech

       ${B}-r${R} ${U}rate${R}
              speech rate (0.1-10, default 1)

       ${B}-p${R} ${U}pitch${R}
              speech pitch (0-2, default 1)

       ${B}-v${R} ${U}voice${R}
              select voice by name (partial match)

${B}EXAMPLES${R}
       echo "Hello world" | speak
       speak -r 1.5 "Fast speech"
       speak --list
`,

  listen: `${B}LISTEN(1)${R}                    Shiro Manual                 ${B}LISTEN(1)${R}

${B}NAME${R}
       listen - speech-to-text via browser SpeechRecognition

${B}SYNOPSIS${R}
       ${B}listen${R} [${U}OPTION${R}]...

${B}DESCRIPTION${R}
       Capture spoken words and output as text. By default, captures a
       single utterance and exits. Output goes to stdout for piping.

       ${B}-c${R}     continuous mode (keep listening until Ctrl+C)

       ${B}-t${R} ${U}secs${R}
              timeout after N seconds

       ${B}-l${R} ${U}lang${R}
              language code (default: en-US)

${B}EXAMPLES${R}
       listen | sh              speak a command to execute it
       listen -c >> notes.txt   dictate continuously to a file
       listen -t 5              listen for 5 seconds
`,

  camera: `${B}CAMERA(1)${R}                    Shiro Manual                 ${B}CAMERA(1)${R}

${B}NAME${R}
       camera - take a webcam snapshot

${B}SYNOPSIS${R}
       ${B}camera${R} [${U}OPTION${R}]...

${B}DESCRIPTION${R}
       Capture a photo from the webcam and save as PNG to the filesystem.
       Prints the saved file path to stdout.

       ${B}-o${R} ${U}file${R}
              output file path (default: camera-TIMESTAMP.png)

${B}EXAMPLES${R}
       camera                         snapshot with auto-named file
       camera -o selfie.png           save to specific file
       camera -o pic.png && img pic.png  capture and display
`,

  notify: `${B}NOTIFY(1)${R}                    Shiro Manual                 ${B}NOTIFY(1)${R}

${B}NAME${R}
       notify - send a browser notification

${B}SYNOPSIS${R}
       ${B}notify${R} [${U}OPTION${R}]... [${U}MESSAGE${R}]

${B}DESCRIPTION${R}
       Send a desktop notification using the browser Notification API.
       Requests permission automatically on first use.

       ${B}-t${R} ${U}title${R}
              notification title (default: "Shiro")

${B}EXAMPLES${R}
       notify "Build complete"
       notify -t "Alert" "Something happened"
       echo "Done" | notify
       build && notify "Finished"
`,

  top: `${B}TOP(1)${R}                       Shiro Manual                      ${B}TOP(1)${R}

${B}NAME${R}
       top - real-time process monitor

${B}SYNOPSIS${R}
       ${B}top${R} [${U}OPTION${R}]...

${B}DESCRIPTION${R}
       Display a live, updating view of running processes. Shows system
       uptime, task counts, memory usage, and per-process details.

       ${B}-d${R} ${U}secs${R}
              refresh delay in seconds (default: 2)

       ${B}-b${R}     batch mode (non-interactive, output to stdout)

       ${B}-n${R} ${U}num${R}
              number of iterations (batch mode)

${B}INTERACTIVE KEYS${R}
       ${B}q${R}          quit
       ${B}k${R}          kill process (prompts for PID)
       ${B}Space${R}      force refresh
`,

  factor: `${B}FACTOR(1)${R}                    Shiro Manual                   ${B}FACTOR(1)${R}

${B}NAME${R}
       factor - print prime factors of numbers

${B}SYNOPSIS${R}
       ${B}factor${R} [${U}NUMBER${R}]...

${B}DESCRIPTION${R}
       Print the prime factors of each NUMBER. Numbers may be specified as
       arguments or read from stdin (one per line).

${B}EXAMPLES${R}
       factor 12
              12: 2 2 3

       factor 17
              17: 17

       echo 100 | factor
              100: 2 2 5 5
`,

  cksum: `${B}CKSUM(1)${R}                     Shiro Manual                   ${B}CKSUM(1)${R}

${B}NAME${R}
       cksum - print CRC checksum and byte count

${B}SYNOPSIS${R}
       ${B}cksum${R} [${U}FILE${R}]...

${B}DESCRIPTION${R}
       Print POSIX CRC32 checksum and byte count for each FILE.
       With no FILE, read standard input.

       Output format: CRC BYTES [FILENAME]

${B}EXAMPLES${R}
       cksum file.txt
              4294967295 0 file.txt

       echo "hello" | cksum
              3287646509 6
`,

  base32: `${B}BASE32(1)${R}                    Shiro Manual                   ${B}BASE32(1)${R}

${B}NAME${R}
       base32 - RFC 4648 Base32 encode or decode

${B}SYNOPSIS${R}
       ${B}base32${R} [${U}OPTION${R}]... [${U}FILE${R}]

${B}DESCRIPTION${R}
       Encode or decode FILE, or standard input, to/from Base32.

       ${B}-d${R}     decode data

       ${B}-w${R} ${U}COLS${R}
              wrap encoded lines at COLS (default 76, 0 to disable)

       ${B}-i${R}     when decoding, ignore non-alphabet characters

${B}EXAMPLES${R}
       echo -n "foo" | base32
              MZXW6===

       echo "MZXW6===" | base32 -d
              foo
`,

  numfmt: `${B}NUMFMT(1)${R}                    Shiro Manual                   ${B}NUMFMT(1)${R}

${B}NAME${R}
       numfmt - convert numbers from/to human-readable strings

${B}SYNOPSIS${R}
       ${B}numfmt${R} [${U}OPTION${R}]... [${U}NUMBER${R}]...

${B}DESCRIPTION${R}
       Reformat NUMBER(s), or numbers from stdin, to/from human-readable.

       ${B}--from${R}=${U}UNIT${R}
              auto-scale input: none, auto, si, iec, iec-i

       ${B}--to${R}=${U}UNIT${R}
              auto-scale output: none, si, iec, iec-i

       ${B}--format${R}=${U}FMT${R}
              use printf-style format (e.g. %.2f)

       ${B}--padding${R}=${U}N${R}
              pad output to N characters

       ${B}--round${R}=${U}METHOD${R}
              rounding: up, down, from-zero, towards-zero, nearest

       ${B}--header${R}[=${U}N${R}]
              pass first N lines through (default 1)

${B}UNITS${R}
       si:    K=1000, M=10^6, G=10^9, T=10^12
       iec:   K=1024, M=2^20, G=2^30, T=2^40
       iec-i: Ki=1024, Mi=2^20, Gi=2^30

${B}EXAMPLES${R}
       numfmt --to=si 1000
              1.0K

       numfmt --to=iec 1048576
              1.0M

       numfmt --from=si 1K
              1000
`,

  csplit: `${B}CSPLIT(1)${R}                    Shiro Manual                   ${B}CSPLIT(1)${R}

${B}NAME${R}
       csplit - split a file into sections by context

${B}SYNOPSIS${R}
       ${B}csplit${R} [${U}OPTION${R}]... ${U}FILE${R} ${U}PATTERN${R}...

${B}DESCRIPTION${R}
       Split FILE into pieces based on PATTERN(s). Outputs byte counts
       for each piece (unless -s). Pieces are written as xx00, xx01, etc.

       ${B}-f${R} ${U}PREFIX${R}
              use PREFIX instead of 'xx'

       ${B}-n${R} ${U}DIGITS${R}
              use specified number of digits (default 2)

       ${B}-s${R}     do not print counts of output file sizes

       ${B}-z${R}     remove empty output files

${B}PATTERNS${R}
       ${B}/regexp/${R}     split before lines matching regexp
       ${B}%regexp%${R}     skip to line matching regexp (discard)
       ${B}N${R}            split at line number N
       ${B}{N}${R}          repeat previous pattern N times
       ${B}{*}${R}          repeat previous pattern as many times as possible

${B}EXAMPLES${R}
       csplit file.txt 5
              Split at line 5

       csplit file.txt '/^Chapter/' '{*}'
              Split before each "Chapter" heading
`,
};

function autoGenerateManPage(name: string, description: string): string {
  return `${B}${name.toUpperCase()}(1)${R}${' '.repeat(Math.max(1, 30 - name.length))}Shiro Manual${' '.repeat(Math.max(1, 30 - name.length))}${B}${name.toUpperCase()}(1)${R}

${B}NAME${R}
       ${name} - ${description}

${B}SYNOPSIS${R}
       ${B}${name}${R} [${U}args${R}]...

${B}DESCRIPTION${R}
       ${description}

       Run "${B}${name} --help${R}" for usage information.
`;
}

export const manCmd: Command = {
  name: 'man',
  description: 'Manual pages',
  async exec(ctx) {
    const { flags, positional } = parseArgs(ctx.args);

    // man -k: apropos — search descriptions
    if (flags.k) {
      const query = positional.join(' ').toLowerCase();
      if (!query) {
        ctx.stderr += 'man -k: what manual page do you want?\n';
        return 1;
      }
      const commands = ctx.shell.commands?.list?.() || [];
      let found = false;
      for (const cmd of commands) {
        if (cmd.name.includes(query) || cmd.description.toLowerCase().includes(query)) {
          ctx.stdout += `${cmd.name}(1) - ${cmd.description}\n`;
          found = true;
        }
      }
      if (!found) {
        ctx.stderr += `${query}: nothing appropriate\n`;
        return 1;
      }
      return 0;
    }

    // man -f: whatis — one-line description
    if (flags.f) {
      for (const name of positional) {
        const cmd = ctx.shell.commands?.get?.(name);
        if (cmd) {
          ctx.stdout += `${cmd.name}(1) - ${cmd.description}\n`;
        } else {
          ctx.stderr += `${name}: nothing appropriate\n`;
        }
      }
      return positional.length > 0 ? 0 : 1;
    }

    if (positional.length === 0) {
      ctx.stderr += 'What manual page do you want?\nUsage: man [command]\n';
      return 1;
    }

    const name = positional[positional.length - 1]; // support `man 1 ls` format

    // Look up curated page first, then auto-generate
    let page = manPages[name];
    if (!page) {
      const cmd = ctx.shell.commands?.get?.(name);
      if (cmd) {
        page = autoGenerateManPage(cmd.name, cmd.description);
      } else {
        ctx.stderr += `No manual entry for ${name}\n`;
        return 1;
      }
    }

    // Pipe through less if available and terminal present
    if (ctx.terminal) {
      const lessCmd = ctx.shell.commands?.get?.('less');
      if (lessCmd) {
        const lessCtx: CommandContext = {
          args: ['-R'],
          fs: ctx.fs,
          cwd: ctx.cwd,
          env: ctx.env,
          stdin: page,
          stdout: '',
          stderr: '',
          shell: ctx.shell,
          terminal: ctx.terminal,
        };
        return lessCmd.exec(lessCtx);
      }
    }

    // Fallback: output directly
    ctx.stdout += page;
    if (!page.endsWith('\n')) ctx.stdout += '\n';
    return 0;
  },
};
