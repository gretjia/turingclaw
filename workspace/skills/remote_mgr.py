#!/usr/bin/env python3
import sys
import subprocess
import argparse
import json

def run_ssh_command(host, user, command, key_file=None):
    """
    Executes a command on a remote host via SSH.
    """
    ssh_cmd = ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes"]
    
    if key_file:
        ssh_cmd.extend(["-i", key_file])
        
    ssh_cmd.append(f"{user}@{host}")
    ssh_cmd.append(command)
    
    try:
        result = subprocess.run(ssh_cmd, capture_output=True, text=True, timeout=30)
        return {
            "success": result.returncode == 0,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
            "returncode": result.returncode
        }
    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "stdout": "",
            "stderr": "Connection timed out.",
            "returncode": -1
        }
    except Exception as e:
        return {
            "success": False,
            "stdout": "",
            "stderr": str(e),
            "returncode": -1
        }

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="TuringClaw Remote Host Manager (SSH)")
    parser.add_argument("host", help="Target host IP or hostname")
    parser.add_argument("command", help="Command to execute")
    parser.add_argument("--user", default="root", help="SSH username (default: root)")
    parser.add_argument("--key", help="Path to SSH private key file")
    
    args = parser.parse_args()
    
    print(f"[TuringClaw] Connecting to {args.user}@{args.host}...")
    result = run_ssh_command(args.host, args.user, args.command, args.key)
    
    if result["success"]:
        print(f"[SUCCESS] Command executed on {args.host}:\n")
        print(result["stdout"])
    else:
        print(f"[ERROR] Failed to execute command on {args.host} (Code: {result['returncode']}):\n")
        if result["stdout"]:
            print("STDOUT:", result["stdout"])
        if result["stderr"]:
            print("STDERR:", result["stderr"])
        sys.exit(result["returncode"])
