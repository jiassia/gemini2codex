using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// A GUI subsystem host has no console of its own. Its child gets a real, initially
// hidden console, which ordinary console descendants can inherit. CREATE_NO_WINDOW
// would instead leave the child without a console and let its descendants flash.
internal static class HiddenConsoleLauncher
{
    private const uint CreateNewConsole = 0x00000010;
    private const uint CreateSuspended = 0x00000004;
    private const uint StartfUseShowWindow = 0x00000001;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint DuplicateSameAccess = 0x00000002;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint Infinite = 0xffffffff;
    private const uint Synchronize = 0x00100000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public uint cb;
        public string lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars;
        public uint dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(string applicationName, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags,
        IntPtr environment, string currentDirectory, ref StartupInfo startup, out ProcessInformation process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle,
        IntPtr targetProcess, out IntPtr targetHandle, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass,
        ref ExtendedLimitInformation information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    // CommandLineToArgvW / Microsoft CRT escaping, not shell escaping. Every token
    // is quoted, including empty strings and trailing backslashes before a quote.
    private static string QuoteArgument(string argument)
    {
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"')
            {
                result.Append('\\', slashes * 2 + 1);
                result.Append('"');
            }
            else
            {
                result.Append('\\', slashes);
                result.Append(character);
            }
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static IntPtr CopyStandardHandle(int identifier)
    {
        IntPtr source = GetStdHandle(identifier);
        if (source == IntPtr.Zero || source == new IntPtr(-1))
            throw new Win32Exception(6);
        IntPtr copy;
        IntPtr current = GetCurrentProcess();
        if (!DuplicateHandle(current, source, current, out copy, 0, true, DuplicateSameAccess))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return copy;
    }

    private static int Main(string[] arguments)
    {
        IntPtr job = IntPtr.Zero, stdin = IntPtr.Zero, stdout = IntPtr.Zero, stderr = IntPtr.Zero, owner = IntPtr.Zero;
        ProcessInformation process = new ProcessInformation();
        bool completed = false;
        try
        {
            if (arguments.Length == 0 || !Path.IsPathRooted(arguments[0]))
                throw new ArgumentException("An absolute native executable path is required.");
            StringBuilder command = new StringBuilder();
            foreach (string argument in arguments)
            {
                if (command.Length != 0) command.Append(' ');
                command.Append(QuoteArgument(argument));
            }
            if (command.Length >= 32767)
                throw new ArgumentException("The Windows command line is too long.");

            string ownerValue = Environment.GetEnvironmentVariable("GEMINI_LAUNCH_PARENT_PID");
            if (!String.IsNullOrEmpty(ownerValue))
            {
                uint ownerPid;
                if (!UInt32.TryParse(ownerValue, out ownerPid) || ownerPid == 0)
                    throw new ArgumentException("The execution owner PID is invalid.");
                owner = OpenProcess(Synchronize, false, ownerPid);
                if (owner == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                // This retained handle identifies the actual process, even if
                // Windows reuses its PID after it exits.
                Environment.SetEnvironmentVariable("GEMINI_LAUNCH_PARENT_PID", null);
            }

            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            ExtendedLimitInformation limits = new ExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation))))
                throw new Win32Exception(Marshal.GetLastWin32Error());

            // Forward the actual pipe handles. No console text API, relay, or
            // encoding conversion can change the Provider's bytes or EOF behavior.
            stdin = CopyStandardHandle(-10);
            stdout = CopyStandardHandle(-11);
            stderr = CopyStandardHandle(-12);
            StartupInfo startup = new StartupInfo();
            startup.cb = (uint)Marshal.SizeOf(typeof(StartupInfo));
            startup.dwFlags = StartfUseShowWindow | StartfUseStdHandles;
            startup.wShowWindow = 0; // SW_HIDE, effective at console creation.
            startup.hStdInput = stdin; startup.hStdOutput = stdout; startup.hStdError = stderr;
            if (!CreateProcessW(arguments[0], command, IntPtr.Zero, IntPtr.Zero, true,
                CreateNewConsole | CreateSuspended, IntPtr.Zero, null, ref startup, out process))
                throw new Win32Exception(Marshal.GetLastWin32Error());

            // The child cannot create descendants before it belongs to the job.
            // The job handle is not inheritable; killing this host closes it and
            // terminates the whole owned tree even when taskkill /T is unavailable.
            if (!AssignProcessToJobObject(job, process.hProcess))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            // The caller owns this optional scratch file. Publish the real PID
            // before Provider code runs without mixing metadata into stdout.
            string pidPath = Environment.GetEnvironmentVariable("GEMINI_LAUNCH_PID_PATH");
            if (!String.IsNullOrEmpty(pidPath))
                File.WriteAllText(pidPath, process.dwProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture), new UTF8Encoding(false));
            if (ResumeThread(process.hThread) == uint.MaxValue)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            CloseHandle(process.hThread); process.hThread = IntPtr.Zero;
            CloseHandle(stdin); stdin = IntPtr.Zero;
            CloseHandle(stdout); stdout = IntPtr.Zero;
            CloseHandle(stderr); stderr = IntPtr.Zero;
            if (owner != IntPtr.Zero)
            {
                uint signalled = WaitForMultipleObjects(2, new IntPtr[] { process.hProcess, owner }, false, Infinite);
                if (signalled == 1)
                {
                    Console.Error.WriteLine("Hidden console launcher stopped: execution owner exited.");
                    return 125; // finally closes the Job Object, reclaiming the whole child tree.
                }
                if (signalled != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            else if (WaitForSingleObject(process.hProcess, Infinite) != 0)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            completed = true;
            return unchecked((int)exitCode);
        }
        catch (Win32Exception error)
        {
            // Paths and arguments can contain prompts or secrets. Report only
            // the Windows error number and keep protocol stdout completely clean.
            Console.Error.WriteLine("Hidden console launcher failed (Windows error " + error.NativeErrorCode + ").");
            return 125;
        }
        catch (Exception)
        {
            Console.Error.WriteLine("Hidden console launcher failed: invalid launch configuration.");
            return 125;
        }
        finally
        {
            if (!completed && process.hProcess != IntPtr.Zero) TerminateProcess(process.hProcess, 125);
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (stdin != IntPtr.Zero) CloseHandle(stdin);
            if (stdout != IntPtr.Zero) CloseHandle(stdout);
            if (stderr != IntPtr.Zero) CloseHandle(stderr);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (owner != IntPtr.Zero) CloseHandle(owner);
        }
    }
}
