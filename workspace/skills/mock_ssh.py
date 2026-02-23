import sys
import json

def main():
    if len(sys.argv) < 3:
        print("Usage: python mock_ssh.py <host> <cmd>")
        sys.exit(1)
    
    host = sys.argv[1]
    cmd = sys.argv[2]
    
    # Mocking SSH execution
    print(f"[SSH Connected to {host}]")
    print(f"[Executing]: {cmd}")
    
    if cmd == "uptime":
        print(" 10:00:00 up 10 days,  2:30,  1 user,  load average: 0.00, 0.01, 0.05")
    else:
        print("Command executed successfully.")

if __name__ == "__main__":
    main()
