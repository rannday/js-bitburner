# New Game

* [Game Guides](https://github.com/bitburner-official/bitburner-src/blob/dev/src/Documentation/doc/en/index.md)
  * [Beginner's Guide](https://github.com/bitburner-official/bitburner-src/blob/dev/src/Documentation/doc/en/help/getting_started.md)

In a new game, you start out with `NUKE.exe` and `hackers-starting-handbook.lit`:

```bash
The Beginner's Guide to Hacking

When starting out, hacking is the most profitable way to earn money and progress. This is a brief collection of tips/pointers on how to make the most out of your hacking scripts.

-hack() and grow() both work by percentages. hack() steals a certain percentage of the money on a server, and grow() increases the amount of money on a server by some percentage (multiplicatively)

-Because hack() and grow() work by percentages, they are more effective if the target server has a high amount of money. Therefore, you should try to increase the amount of money on a server (using grow()) to a certain amount before hacking it. Two important Netscript functions for this are getServerMoneyAvailable() and getServerMaxMoney()

-Keep security level low. Security level affects everything when hacking. Two important Netscript functions for this are getServerSecurityLevel() and getServerMinSecurityLevel()

-Purchase additional cloud servers by visiting "Alpha Enterprises" in the city. They are relatively cheap and give you valuable RAM to run more scripts early in the game

-Prioritize upgrading the RAM on your home computer. This can also be done at "Alpha Enterprises"

-Many low level servers have free RAM. You can use this RAM to run your scripts. Use the scp Terminal or Netscript command to copy your scripts onto these servers and then run them.

```

## Help
```bash
[home /]> help
Type 'help name' to learn more about the command 
 
    alias [-g] [name="value"]        Create or display Terminal aliases
    analyze                          Get information about the current machine 
    backdoor                         Install a backdoor on the current machine 
    buy [-l/-a/program]              Purchase a program through the Dark Web
    cat [file]                       Display the contents of a file
    cd [dir]                         Change to a new directory
    changelog                        Display changelog
    check [script] [args...]         Print a script's logs to Terminal
    clear                            Clear all text on the terminal 
    cls                              See 'clear' command 
    connect [hostname]               Connects to a remote server
    cp [src] [dest]                  Copy a file
    download [script/text file]      Downloads scripts or text files to your computer
    upload [dir]                     Upload scripts or text files from your computer
    expr [math expression]           Evaluate a mathematical expression
    free                             Check the machine's memory (RAM) usage
    grep [opts]... pattern [file]... Search for PATTERN (string/regular expression) in each FILE and print results to terminal
         [-O] [target file]
    grow                             Spoof money in a servers bank account, increasing the amount available.
    hack                             Hack the current machine
    help [command]                   Display this help text, or the help text for a command
    history [-c]                     Display the terminal history
    home                             Connect to home computer
    hostname                         Displays the hostname of the machine
    ipaddr                           Displays the IP address of the machine
    kill [script/pid] [args...]      Stops the specified script on the current server 
    killall                          Stops all running scripts on the current machine
    ls [dir] [-l] [-h] [-g pattern]  Displays all files on the machine
    lscpu                            Displays the number of CPU cores on the machine
    mem [script] [-t n]              Displays the amount of RAM required to run the script
    mv [src] [dest]                  Move/rename a text or script file
    nano [files...]                  Text editor - Open up and edit one or more scripts or text files
    ps                               Display all scripts that are currently running
    rm [OPTIONS]... [FILE]...        Delete a file from the server
    run [script] [-t n] [--tail]     Run a program, a script, or a coding contract
        [--ram-override n]
        [--temporary] [args...]
    scan                             Prints all immediately-available network connections
    scan-analyze [d] [-a]            Prints info for all servers up to d nodes away
    scp [files...] [server]          Copies scripts, text files, or .lit files to a destination server
    sudov                            Shows whether you have root access on this computer
    tail [script/pid] [args...]      Displays dynamic logs for the specified script
    top                              Displays all running scripts and their RAM usage
    unalias [alias name]             Deletes the specified alias
    vim [files...]                   Text editor - Open up and edit one or more scripts or text files in vim mode
    weaken                           Reduce the security of the current machine
    wget [url] [target file]         Retrieves code/text from a web server
```

### scan
```bash
[home /]> help scan
Usage: scan
 
Prints all immediately-available network connection. This will print a list of all servers that you can currently connect 
to using the 'connect' Terminal command.
```
### scan-analyze
```bash
[home /]> help scan-analyze 
Usage: scan-analyze [depth] [-a]
 
Prints detailed information about all servers up to [depth] nodes away on the network. Calling 
'scan-analyze 1' will display information for the same servers that are shown by the 'scan' Terminal 
command. This command also shows the relative paths to reach each server.
 
By default, the maximum depth that can be specified for 'scan-analyze' is 3. However, once you have 
the DeepscanV1.exe and DeepscanV2.exe programs, you can execute 'scan-analyze' with a depth up to 
5 and 10, respectively.
 
The information 'scan-analyze' displays about each server includes whether or not you have root access to it, 
its required hacking level, the number of open ports required to run NUKE.exe on it, and how much RAM 
it has.
 
By default, this command will not display servers that you have purchased. However, you can pass in the 
-a flag at the end of the command if you would like to enable that.
```
