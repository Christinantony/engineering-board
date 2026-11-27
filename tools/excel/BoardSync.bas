Attribute VB_Name = "BoardSync"
Option Explicit

' Engineering Board workbook link (decision #47).
'
' Keeps the Master List of this workbook and a project's Procurement list on
' the Engineering Board as one list. A change typed here is sent to the board
' a moment later; a change made on the board is written here within half a
' minute while the workbook is open, and when it is next opened.
'
' This macro has no rules of its own. Each round it sends every row twice:
' the cells as they stood after the last round (kept in the hidden BOARD BASE
' column) and the cells as they are now. The board decides what changed where,
' saves the workbook's changes, and answers with the whole list. The macro
' writes the cells that differ, and asks when the same cell was changed in
' both places.
'
' Set up once:  Alt+F8, run BoardSync_Setup, give the board's address and a
'               key from the project's Procurement page (Workbook link tab).
' Run by hand:  BoardSync_Now        Stop for good:  BoardSync_Unlink
'
' Keep whole rows together: insert, delete, cut and sort entire rows, so the
' hidden BOARD ID and BOARD BASE cells stay with their part.

Private Const PROTO As String = "EB1"
Private Const SHEET_MASTER As String = "Master List"
Private Const SHEET_PM As String = "Procurement Management"
Private Const SHEET_SYNC As String = "Board Sync"
Private Const SHEET_LIVE As String = "Live Status"
Private Const TITLE As String = "Board sync"

Private Const TICK_SECONDS As Long = 30
Private Const SOON_SECONDS As Long = 2

' the cells of a row that are kept in step, in the order the board expects
Private Const NFIELDS As Long = 12
Private Const F_NAME As Long = 0
Private Const F_SPEC As Long = 1
Private Const F_QTY As Long = 2
Private Const F_TOTAL As Long = 3
Private Const F_INV As Long = 4
Private Const F_MAT As Long = 5
Private Const F_REM As Long = 6
Private Const F_COAT As Long = 7
Private Const F_CAT As Long = 8
Private Const F_DISC As Long = 9
Private Const F_MEANS As Long = 10
Private Const F_STATUS As Long = 11

' rows of column B on the Board Sync sheet
Private Const S_ADDRESS As Long = 1
Private Const S_KEY As Long = 2
Private Const S_PROJECT As Long = 3
Private Const S_TOKEN As Long = 4
Private Const S_LAST As Long = 5
Private Const S_DRIVERS As Long = 6
Private Const PROBLEM_ROW As Long = 9

' timer and state
Private mTickAt As Date
Private mTickOn As Boolean
Private mBusy As Boolean
Private mWriting As Boolean
Private mPaused As Boolean
Private mFailures As Long
Private mDidWrite As Boolean
Private mProblems As String
Private mLiveSig As String
Private mAnswered As Collection
Private mLive As Collection
Private mStep As String

' where things are in this workbook (found afresh each round)
Private wsM As Worksheet
Private wsP As Worksheet
Private mCol(0 To 11) As Long
Private cItem As Long
Private cProc As Long
Private cId As Long
Private cBase As Long
Private rHdr As Long
Private rFirst As Long
Private rLast As Long
Private pStatus As Long
Private pDate As Long
Private pFirst As Long
Private pLast As Long
Private rngDrv(0 To 2) As Range

' ---------------------------------------------------------------- entry points

Public Sub BoardSync_Setup()
    Dim ws As Worksheet, addr As String, k As String
    Set ws = SyncSheet(True)
    addr = InputBox("The board's address, as in the browser (for example http://PC-NAME:8080):", TITLE, TextOf(ws.Cells(S_ADDRESS, 2).Value))
    addr = Trim$(addr)
    If Len(addr) = 0 Then Exit Sub
    Do While Right$(addr, 1) = "/"
        addr = Left$(addr, Len(addr) - 1)
    Loop
    If LCase$(Left$(addr, 4)) <> "http" Then addr = "http://" & addr
    k = InputBox("The workbook key (board: the project's Procurement page, Workbook link tab):", TITLE, TextOf(ws.Cells(S_KEY, 2).Value))
    k = Trim$(k)
    If Len(k) = 0 Then Exit Sub
    ws.Cells(S_ADDRESS, 2).Value = addr
    ws.Cells(S_KEY, 2).Value = k
    mPaused = False
    mFailures = 0
    RunSync True
End Sub

Public Sub BoardSync_Now()
    If Not HasSettings() Then
        MsgBox "This workbook is not linked to the board yet. Run BoardSync_Setup first.", vbInformation, TITLE
        Exit Sub
    End If
    mPaused = False
    mFailures = 0
    RunSync True
End Sub

Public Sub BoardSync_Unlink()
    Dim ws As Worksheet
    If MsgBox("Stop syncing this workbook with the board?" & vbLf & vbLf & _
              "The Master List stays as it is, here and on the board. To link again, run BoardSync_Setup.", _
              vbYesNo + vbQuestion + vbDefaultButton2, TITLE) <> vbYes Then Exit Sub
    CancelTick
    On Error GoTo Failed
    BeginWrite
    If Layout() Then ClearLink
    Set ws = SyncSheet(False)
    If Not ws Is Nothing Then ws.Cells(S_KEY, 2).ClearContents
    EndWrite
    Application.StatusBar = False
    Exit Sub
Failed:
    EndWrite
    MsgBox "Could not unlink: " & Err.Description, vbExclamation, TITLE
End Sub

' Workbook_Open and Workbook_AfterSave
Public Sub BoardSync_Start()
    If HasSettings() And Not mPaused Then ScheduleTick SOON_SECONDS
End Sub

' Workbook_BeforeClose, and before Save As
Public Sub BoardSync_Stop()
    CancelTick
    On Error Resume Next
    Application.StatusBar = False
End Sub

' Workbook_SheetChange: something was typed, so sync in a moment
Public Sub BoardSync_Changed(ByVal Sh As Object)
    If mWriting Or mBusy Or mPaused Then Exit Sub
    If Sh.Name <> SHEET_MASTER And Sh.Name <> SHEET_PM Then Exit Sub
    If Not HasSettings() Then Exit Sub
    ScheduleTick SOON_SECONDS
End Sub

' the timer
Public Sub BoardSync_Tick()
    mTickOn = False
    RunSync False
End Sub

' ---------------------------------------------------------------- the timer

Private Function TickName() As String
    TickName = "'" & Replace(ThisWorkbook.Name, "'", "''") & "'!BoardSync_Tick"
End Function

Private Sub ScheduleTick(ByVal seconds As Long)
    CancelTick
    On Error Resume Next
    mTickAt = Now + seconds / 86400#
    Application.OnTime mTickAt, TickName()
    mTickOn = (Err.Number = 0)
End Sub

Private Sub CancelTick()
    On Error Resume Next
    If mTickOn Then Application.OnTime mTickAt, TickName(), , False
    mTickOn = False
End Sub

Private Sub RunSync(ByVal interactive As Boolean)
    Dim delay As Long
    If mBusy Then Exit Sub
    If Not HasSettings() Then Exit Sub
    If mPaused And Not interactive Then Exit Sub
    ' writing cells would cancel a copy the person has in progress: come back shortly
    If Not interactive And Application.CutCopyMode <> False Then
        ScheduleTick 5
        Exit Sub
    End If
    delay = TICK_SECONDS
    mBusy = True
    On Error GoTo Failed
    BeginWrite
    If SyncOnce(interactive, "auto") Then
        mFailures = 0
    Else
        ' the board is off or unreachable: ask less often, up to every five minutes
        If mFailures < 4 Then mFailures = mFailures + 1
        delay = TICK_SECONDS * (2 ^ mFailures)
        If delay > 300 Then delay = 300
    End If
Done:
    On Error Resume Next
    EndWrite
    mBusy = False
    If HasSettings() And Not mPaused Then ScheduleTick delay
    Exit Sub
Failed:
    Application.StatusBar = TITLE & ": stopped while " & mStep & " (" & Err.Description & "). It will try again."
    If interactive Then MsgBox "The sync stopped while " & mStep & "." & vbLf & vbLf & "Error " & Err.Number & ": " & Err.Description, vbExclamation, TITLE
    delay = 300
    Resume Done
End Sub

Private Sub BeginWrite()
    mWriting = True
    Application.EnableEvents = False
    Application.ScreenUpdating = False
End Sub

Private Sub EndWrite()
    Application.EnableEvents = True
    Application.ScreenUpdating = True
    mWriting = False
End Sub

Private Sub Note(ByVal message As String)
    Application.StatusBar = TITLE & ": " & message
End Sub

' ---------------------------------------------------------------- one round

Private Function SyncOnce(ByVal interactive As Boolean, ByVal mode As String) As Boolean
    Dim body As String, reply As String, httpStatus As Long
    Dim lines() As String, head() As String, answer As VbMsgBoxResult

    mStep = "finding the Master List's columns"
    If Not Layout() Then
        Note "the Master List sheet, or its PART NAME, QTY / UNIT, TOTAL QTY, CATEGORY or MEANS column, was not found."
        If interactive Then MsgBox "The Master List sheet, or one of its PART NAME, QTY / UNIT, TOTAL QTY, CATEGORY or MEANS columns, was not found.", vbExclamation, TITLE
        Exit Function
    End If
    mStep = "adding the hidden BOARD ID columns"
    EnsureColumns
    mStep = "checking each row's hidden id"
    RepairMoved

    mStep = "reading the Master List"
    body = BuildBody(mode)
    mStep = "sending to the board"
    reply = HttpPost(Setting(S_ADDRESS) & "/api/sync", Setting(S_KEY), body, httpStatus)
    If httpStatus = 0 Then
        Note "the board cannot be reached. The workbook will sync when it can."
        If interactive Then MsgBox "The board cannot be reached at " & Setting(S_ADDRESS) & "." & vbLf & vbLf & "Check that the board is running and the address is right. The workbook will sync when it can.", vbExclamation, TITLE
        Exit Function
    End If
    mStep = "reading the board's answer"
    lines = Split(Replace(reply, vbCr, ""), vbLf)
    If UBound(lines) < 0 Then
        Note "the board gave an empty answer (HTTP " & httpStatus & ")."
        Exit Function
    End If
    SplitLine lines(0), head
    If Fld(head, 0) <> PROTO Then
        Note "that address answered, but not as the board does (HTTP " & httpStatus & "). Check the board address."
        If interactive Then MsgBox "That address answered, but not as the board does (HTTP " & httpStatus & ")." & vbLf & "Check the board address, and that the board is version 2.5.0 or later.", vbExclamation, TITLE
        Exit Function
    End If

    Select Case Fld(head, 1)
        Case "ok"
            ApplyReply lines, head
            SyncOnce = True

        Case "ask-first"
            ' this workbook has never synced, and the board's list already has parts
            answer = MsgBox("""" & Fld(head, 3) & """ on the board already has " & Fld(head, 4) & " part(s)." & vbLf & vbLf & _
                            "Yes = discard the board's parts and use this workbook's Master List" & vbLf & _
                            "No = keep them: match by part name, and bring the rest into this workbook" & vbLf & _
                            "Cancel = do nothing for now", vbYesNoCancel + vbQuestion + vbDefaultButton3, TITLE)
            If answer = vbYes Then
                SyncOnce = SyncOnce(interactive, "first-replace")
            ElseIf answer = vbNo Then
                SyncOnce = SyncOnce(interactive, "first-merge")
            Else
                mPaused = True
                Note "not linked yet. Run BoardSync_Now to try again."
                SyncOnce = True
            End If

        Case "relink"
            ' the hidden ids in this workbook belong to another project or another board
            answer = MsgBox("This workbook was linked to a different project or board." & vbLf & vbLf & _
                            "Link it to """ & Fld(head, 3) & """ instead, starting afresh?", vbYesNo + vbQuestion + vbDefaultButton2, TITLE)
            If answer = vbYes Then
                ClearLink
                SyncOnce = SyncOnce(interactive, "auto")
            Else
                mPaused = True
                Note "not linked. Run BoardSync_Setup to link this workbook."
                SyncOnce = True
            End If

        Case Else
            Note Fld(head, 2)
            If httpStatus = 401 Or httpStatus = 403 Then
                mPaused = True
                MsgBox Fld(head, 2) & vbLf & vbLf & "Syncing is paused. Run BoardSync_Setup to give this workbook a new key.", vbExclamation, TITLE
                SyncOnce = True
            ElseIf interactive Then
                MsgBox Fld(head, 2), vbExclamation, TITLE
            End If
    End Select
End Function

' ---------------------------------------------------------------- finding things

Private Function HeadKey(ByVal v As Variant) As String
    Dim s As String, i As Long, c As String, out As String
    If IsError(v) Then Exit Function
    If IsEmpty(v) Then Exit Function
    s = UCase$(CStr(v))
    For i = 1 To Len(s)
        c = Mid$(s, i, 1)
        If c >= "A" And c <= "Z" Then out = out & c
    Next
    HeadKey = out
End Function

Private Function Layout() As Boolean
    Dim r As Long, c As Long, f As Long, h As String, v As Variant, nm As Name
    Set wsM = Nothing
    Set wsP = Nothing
    On Error Resume Next
    Set wsM = ThisWorkbook.Worksheets(SHEET_MASTER)
    Set wsP = ThisWorkbook.Worksheets(SHEET_PM)
    On Error GoTo 0
    If wsM Is Nothing Then Exit Function

    For f = 0 To NFIELDS - 1
        mCol(f) = 0
    Next
    cItem = 0: cProc = 0: cId = 0: cBase = 0: rHdr = 0

    ' the header row is the one with PART NAME in it
    v = wsM.Range(wsM.Cells(1, 1), wsM.Cells(15, 60)).Value
    For r = 1 To 15
        For c = 1 To 60
            If HeadKey(v(r, c)) = "PARTNAME" Then
                rHdr = r
                Exit For
            End If
        Next
        If rHdr > 0 Then Exit For
    Next
    If rHdr = 0 Then Exit Function

    For c = 1 To 60
        h = HeadKey(v(rHdr, c))
        Select Case h
            Case "PARTNAME": mCol(F_NAME) = c
            Case "FINALSIZE", "FINALSIZESPEC": mCol(F_SPEC) = c
            Case "QTYUNIT": mCol(F_QTY) = c
            Case "TOTALQTY": mCol(F_TOTAL) = c
            Case "INVENTORY": mCol(F_INV) = c
            Case "MATERIAL": mCol(F_MAT) = c
            Case "REMARKS": mCol(F_REM) = c
            Case "COATING": mCol(F_COAT) = c
            Case "CATEGORY": mCol(F_CAT) = c
            Case "DISCIPLINE": mCol(F_DISC) = c
            Case "MEANS": mCol(F_MEANS) = c
            Case "ITEM": cItem = c
            Case "INPROCUREMENT": cProc = c
            Case "BOARDID": cId = c
            Case "BOARDBASE": cBase = c
        End Select
    Next
    If mCol(F_NAME) = 0 Or mCol(F_QTY) = 0 Or mCol(F_TOTAL) = 0 Or mCol(F_CAT) = 0 Or mCol(F_MEANS) = 0 Then Exit Function

    ' the rows of the list: as the workbook's own MasterInput range says, or sixty
    rFirst = rHdr + 1
    rLast = rHdr + 60
    On Error Resume Next
    Set nm = ThisWorkbook.Names("MasterInput")
    If Not nm Is Nothing Then
        If nm.RefersToRange.Worksheet.Name = SHEET_MASTER Then
            rLast = nm.RefersToRange.Areas(1).Row + nm.RefersToRange.Areas(1).Rows.Count - 1
        End If
    End If
    On Error GoTo 0
    If rLast < rFirst + 1 Then rLast = rHdr + 60

    ' the three quantity drivers: the cell under each heading
    For f = 0 To 2
        Set rngDrv(f) = Nothing
    Next
    For r = 1 To 14
        For c = 1 To 60
            h = HeadKey(v(r, c))
            If h = "NUMBEROFARRAYS" Then Set rngDrv(0) = wsM.Cells(r + 1, c)
            If h = "ANTENNASPERARRAY" Then Set rngDrv(1) = wsM.Cells(r + 1, c)
            If Left$(h, 13) = "EXTRAANTENNAS" Then Set rngDrv(2) = wsM.Cells(r + 1, c)
        Next
    Next
    If rngDrv(0) Is Nothing Or rngDrv(1) Is Nothing Or rngDrv(2) Is Nothing Then
        For f = 0 To 2
            Set rngDrv(f) = Nothing
        Next
    End If

    ' the Status column of the Procurement Management sheet's tracker, row for row with the Master List
    pStatus = 0: pDate = 0: pFirst = 0: pLast = 0
    If Not wsP Is Nothing Then
        v = wsP.Range(wsP.Cells(1, 1), wsP.Cells(300, 1)).Value
        For r = 1 To 299
            If Left$(HeadKey(v(r, 1)), 13) = "STATUSTRACKER" Then
                For c = 1 To 20
                    h = HeadKey(wsP.Cells(r + 1, c).Value)
                    If h = "STATUS" Then pStatus = c
                    If Left$(h, 8) = "DATETIME" Then pDate = c
                Next
                pFirst = r + 2
                Exit For
            End If
        Next
        If pStatus = 0 Then
            Set wsP = Nothing
        Else
            ' the tracker has a row for each of the first so many Master List rows: its formulas say how many
            pLast = pFirst
            Do While wsP.Cells(pLast + 1, 1).HasFormula And pLast - pFirst < 2000
                pLast = pLast + 1
            Loop
        End If
    End If
    Layout = True
End Function

' the two hidden columns that tie a row to its part on the board
Private Sub EnsureColumns()
    Dim c As Long
    If cId > 0 And cBase > 0 Then Exit Sub
    c = 27
    Do While Len(HeadKey(wsM.Cells(rHdr, c).Value)) > 0 Or Len(HeadKey(wsM.Cells(rHdr, c + 1).Value)) > 0
        c = c + 2
    Loop
    wsM.Cells(rHdr, c).Value = "BOARD ID"
    wsM.Cells(rHdr, c + 1).Value = "BOARD BASE"
    wsM.Range(wsM.Columns(c), wsM.Columns(c + 1)).Hidden = True
    cId = c
    cBase = c + 1
    mDidWrite = True
End Sub

Private Function SyncSheet(ByVal create As Boolean) As Worksheet
    Dim ws As Worksheet, act As Object
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(SHEET_SYNC)
    On Error GoTo 0
    If ws Is Nothing And create Then
        Set act = ActiveSheet
        Set ws = ThisWorkbook.Worksheets.Add(After:=ThisWorkbook.Worksheets(ThisWorkbook.Worksheets.Count))
        ws.Name = SHEET_SYNC
        ws.Cells(S_ADDRESS, 1).Value = "Board address"
        ws.Cells(S_KEY, 1).Value = "Workbook key"
        ws.Cells(S_PROJECT, 1).Value = "Linked project"
        ws.Cells(S_TOKEN, 1).Value = "Link token (do not edit)"
        ws.Cells(S_LAST, 1).Value = "Last change synced"
        ws.Cells(S_DRIVERS, 1).Value = "Drivers at last sync (do not edit)"
        ws.Cells(PROBLEM_ROW - 1, 1).Value = "Rows needing attention"
        ws.Cells(1, 4).Value = "Known parts (do not edit)"
        ws.Cells(1, 5).Value = "Part name"
        ws.Range("A1:A8").Font.Bold = True
        ws.Range("D1:E1").Font.Bold = True
        ws.Columns(1).ColumnWidth = 34
        ws.Columns(2).ColumnWidth = 46
        ws.Columns(2).NumberFormat = "@"
        ws.Columns(4).NumberFormat = "@"
        ws.Columns(5).NumberFormat = "@"
        If Not act Is Nothing Then act.Activate
    End If
    Set SyncSheet = ws
End Function

Private Function Setting(ByVal n As Long) As String
    Dim ws As Worksheet
    Set ws = SyncSheet(False)
    If ws Is Nothing Then Exit Function
    Setting = Trim$(TextOf(ws.Cells(n, 2).Value))
End Function

Private Sub SetSetting(ByVal n As Long, ByVal v As String)
    Dim ws As Worksheet
    Set ws = SyncSheet(True)
    If TextOf(ws.Cells(n, 2).Value) <> v Then ws.Cells(n, 2).Value = "'" & v
End Sub

Private Function HasSettings() As Boolean
    On Error Resume Next
    HasSettings = (Len(Setting(S_ADDRESS)) > 0 And Len(Setting(S_KEY)) > 0)
End Function

' A small text -> text map, kept in a Collection as key, value, key, value...
' (No Scripting.Dictionary, so nothing has to be installed or allowed.)
Private Function MapAt(ByVal m As Collection, ByVal k As String) As Long
    Dim i As Long
    For i = 1 To m.Count Step 2
        If CStr(m.Item(i)) = k Then
            MapAt = i
            Exit Function
        End If
    Next
End Function

Private Function MapHas(ByVal m As Collection, ByVal k As String) As Boolean
    MapHas = (MapAt(m, k) > 0)
End Function

Private Function MapGet(ByVal m As Collection, ByVal k As String) As String
    Dim i As Long
    i = MapAt(m, k)
    If i > 0 Then MapGet = CStr(m.Item(i + 1))
End Function

Private Sub MapSet(ByVal m As Collection, ByVal k As String, ByVal v As String)
    Dim i As Long
    i = MapAt(m, k)
    If i > 0 Then
        m.Remove i + 1
        m.Remove i
    End If
    m.Add k
    m.Add v
End Sub

' ---------------------------------------------------------------- text and the wire format

' a cell's value as the text the board compares
Private Function TextOf(ByVal v As Variant) As String
    If IsError(v) Then Exit Function
    If IsEmpty(v) Then Exit Function
    If IsNull(v) Then Exit Function
    Select Case VarType(v)
        Case vbString
            TextOf = v
        Case vbDate
            If v = Int(v) Then TextOf = Format$(v, "yyyy-mm-dd") Else TextOf = Format$(v, "yyyy-mm-dd hh:nn")
        Case vbBoolean
            If v Then TextOf = "TRUE" Else TextOf = "FALSE"
        Case Else
            TextOf = NumText(CDbl(v))
    End Select
End Function

' a number with a full stop for the decimal point, whatever Windows is set to
Private Function NumText(ByVal d As Double) As String
    Dim s As String
    s = Trim$(Str$(d))
    If Left$(s, 1) = "." Then s = "0" & s
    If Left$(s, 2) = "-." Then s = "-0" & Mid$(s, 2)
    NumText = s
End Function

Private Function LooksNumber(ByVal s As String) As Boolean
    Dim i As Long, c As String, dots As Long, digits As Long
    s = Trim$(s)
    If Len(s) = 0 Then Exit Function
    For i = 1 To Len(s)
        c = Mid$(s, i, 1)
        If c >= "0" And c <= "9" Then
            digits = digits + 1
        ElseIf c = "." Then
            dots = dots + 1
        ElseIf c = "-" And i = 1 Then
        Else
            Exit Function
        End If
    Next
    LooksNumber = (digits > 0 And dots <= 1)
End Function

Private Function IsDigits(ByVal s As String) As Boolean
    Dim i As Long, c As String
    If Len(s) = 0 Or Len(s) > 12 Then Exit Function
    For i = 1 To Len(s)
        c = Mid$(s, i, 1)
        If c < "0" Or c > "9" Then Exit Function
    Next
    IsDigits = True
End Function

' text that Excel would turn into a number, a date or a formula is written as text
Private Function SafeText(ByVal s As String) As String
    Dim c As String
    If Len(s) = 0 Then Exit Function
    c = Left$(s, 1)
    If c = "=" Or c = "+" Or c = "-" Or c = "@" Or c = "'" Or LooksNumber(s) Or IsDate(s) Then
        SafeText = "'" & s
    Else
        SafeText = s
    End If
End Function

' plain ASCII on the wire: \t \n \\ and \uXXXX for everything else
Private Function Esc(ByVal s As String) As String
    Dim i As Long, c As Long, ch As String, out As String
    For i = 1 To Len(s)
        ch = Mid$(s, i, 1)
        c = AscW(ch)
        If c < 0 Then c = c + 65536
        Select Case c
            Case 92
                out = out & "\\"
            Case 9
                out = out & "\t"
            Case 10
                out = out & "\n"
            Case 13
            Case 32 To 126
                out = out & ch
            Case Else
                out = out & "\u" & Right$("0000" & Hex$(c), 4)
        End Select
    Next
    Esc = out
End Function

' four hex digits as a number, worked out digit by digit
Private Function HexValue(ByVal h As String) As Long
    Dim i As Long, c As Long, n As Long
    For i = 1 To Len(h)
        c = Asc(UCase$(Mid$(h, i, 1)))
        If c >= 48 And c <= 57 Then
            n = n * 16 + (c - 48)
        ElseIf c >= 65 And c <= 70 Then
            n = n * 16 + (c - 55)
        Else
            n = n * 16
        End If
    Next
    If n < 1 Or n > 65535 Then n = 63
    HexValue = n
End Function

Private Function Unesc(ByVal s As String) As String
    Dim i As Long, n As Long, ch As String, nx As String, out As String
    If InStr(1, s, "\", vbBinaryCompare) = 0 Then
        Unesc = s
        Exit Function
    End If
    n = Len(s)
    i = 1
    Do While i <= n
        ch = Mid$(s, i, 1)
        If ch = "\" And i < n Then
            nx = Mid$(s, i + 1, 1)
            If nx = "t" Then
                out = out & vbTab
                i = i + 2
            ElseIf nx = "n" Then
                out = out & vbLf
                i = i + 2
            ElseIf nx = "r" Then
                i = i + 2
            ElseIf nx = "u" And i + 5 <= n Then
                out = out & ChrW$(HexValue(Mid$(s, i + 2, 4)))
                i = i + 6
            Else
                out = out & nx
                i = i + 2
            End If
        Else
            out = out & ch
            i = i + 1
        End If
    Loop
    Unesc = out
End Function

' one line of the board's answer, split into its fields
Private Sub SplitLine(ByVal s As String, ByRef a() As String)
    Dim i As Long
    If Len(s) = 0 Then
        ReDim a(0 To 0)
        Exit Sub
    End If
    a = Split(s, vbTab)
    For i = 0 To UBound(a)
        a(i) = Unesc(a(i))
    Next
End Sub

Private Function Fld(ByRef a() As String, ByVal i As Long) As String
    If i >= 0 And i <= UBound(a) Then Fld = a(i)
End Function

' a BOARD BASE cell: twelve fields, already escaped, with tabs between; anything else counts as none
Private Function BaseOf(ByVal v As Variant) As String
    Dim s As String
    s = TextOf(v)
    If Len(s) - Len(Replace(s, vbTab, "")) = NFIELDS - 1 Then BaseOf = s
End Function

Private Function HttpPost(ByVal url As String, ByVal k As String, ByVal body As String, ByRef httpStatus As Long) As String
    Dim h As Object
    httpStatus = 0
    On Error GoTo Failed
    Set h = CreateObject("WinHttp.WinHttpRequest.5.1")
    h.SetTimeouts 2000, 2000, 5000, 15000
    h.Open "POST", url, False
    h.SetRequestHeader "Content-Type", "text/plain"
    h.SetRequestHeader "X-Board-Key", k
    h.Send body
    httpStatus = h.Status
    HttpPost = h.ResponseText
    Exit Function
Failed:
    httpStatus = 0
    HttpPost = ""
End Function

' ---------------------------------------------------------------- what to send

Private Function DriverBase() As String
    Dim a() As String
    a = Split(Setting(S_DRIVERS), "|")
    If UBound(a) = 2 Then
        DriverBase = Esc(a(0)) & vbTab & Esc(a(1)) & vbTab & Esc(a(2))
    Else
        DriverBase = vbTab & vbTab
    End If
End Function

Private Function DriverCur() As String
    If rngDrv(0) Is Nothing Then
        DriverCur = DriverBase()
    Else
        DriverCur = Esc(TextOf(rngDrv(0).Value)) & vbTab & Esc(TextOf(rngDrv(1).Value)) & vbTab & Esc(TextOf(rngDrv(2).Value))
    End If
End Function

' the parts this workbook knew after the last round: id -> name
Private Function KnownParts() As Collection
    Dim d As Collection, ws As Worksheet, r As Long, idText As String
    Set d = New Collection
    Set ws = SyncSheet(False)
    If Not ws Is Nothing Then
        r = 2
        Do
            idText = Trim$(TextOf(ws.Cells(r, 4).Value))
            If Len(idText) = 0 Then Exit Do
            MapSet d, idText, TextOf(ws.Cells(r, 5).Value)
            r = r + 1
        Loop While r < 2000
    End If
    Set KnownParts = d
End Function

' Cells moved without their row (a sort of part of the sheet, a cut and paste)
' leave the hidden id on the wrong row. Where a row shows a part whose id sits
' on another row, the id is moved back to it.
Private Sub RepairMoved()
    Dim n As Long, i As Long, j As Long, moved As Boolean
    Dim ids() As String, bases() As String, names() As String, baseNames() As String
    Dim newId() As String, newBase() As String, got() As Boolean, taken() As Boolean
    Dim byName As Collection, dup As Collection, a() As String

    n = rLast - rFirst + 1
    ReDim ids(1 To n): ReDim bases(1 To n): ReDim names(1 To n): ReDim baseNames(1 To n)
    ReDim got(1 To n): ReDim taken(1 To n)
    Set byName = New Collection
    Set dup = New Collection
    For i = 1 To n
        names(i) = Trim$(TextOf(wsM.Cells(rFirst + i - 1, mCol(F_NAME)).Value))
        ids(i) = Trim$(TextOf(wsM.Cells(rFirst + i - 1, cId).Value))
        bases(i) = BaseOf(wsM.Cells(rFirst + i - 1, cBase).Value)
        If Len(ids(i)) > 0 And Len(bases(i)) > 0 Then
            a = Split(bases(i), vbTab)
            baseNames(i) = Trim$(Unesc(a(0)))
            If names(i) <> baseNames(i) And Len(baseNames(i)) > 0 Then
                If MapHas(byName, baseNames(i)) Then
                    MapSet dup, baseNames(i), "1"
                Else
                    MapSet byName, baseNames(i), CStr(i)
                End If
            End If
        End If
    Next
    If byName.Count = 0 Then Exit Sub

    ReDim newId(1 To n): ReDim newBase(1 To n)
    For i = 1 To n
        newId(i) = ids(i)
        newBase(i) = bases(i)
    Next
    For i = 1 To n
        If Len(names(i)) > 0 And (Len(ids(i)) = 0 Or names(i) <> baseNames(i)) Then
            If MapHas(byName, names(i)) Then
                If Not MapHas(dup, names(i)) Then
                    j = CLng(MapGet(byName, names(i)))
                    If j <> i Then
                        newId(i) = ids(j)
                        newBase(i) = bases(j)
                        got(i) = True
                        taken(j) = True
                        moved = True
                    End If
                End If
            End If
        End If
    Next
    If Not moved Then Exit Sub
    For i = 1 To n
        ' a row whose id went elsewhere and which received none starts again without one
        If taken(i) And Not got(i) Then
            newId(i) = ""
            newBase(i) = ""
        End If
        If newId(i) <> ids(i) Or newBase(i) <> bases(i) Then
            If Len(newId(i)) = 0 Then
                wsM.Cells(rFirst + i - 1, cId).ClearContents
                wsM.Cells(rFirst + i - 1, cBase).ClearContents
            Else
                wsM.Cells(rFirst + i - 1, cId).Value = "'" & newId(i)
                wsM.Cells(rFirst + i - 1, cBase).Value = "'" & newBase(i)
            End If
            mDidWrite = True
        End If
    Next
End Sub

Private Function BuildBody(ByVal mode As String) As String
    Dim n As Long, i As Long, f As Long, used As Long, lastCol As Long, asked As Long
    Dim data As Variant, pm As Variant
    Dim parts() As String, b() As String
    Dim nm As String, idText As String, baseText As String, cur As String, v As String, askList As String
    Dim seen As Collection, known As Collection
    Dim answer As VbMsgBoxResult

    n = rLast - rFirst + 1
    lastCol = cBase
    If cId > lastCol Then lastCol = cId
    For f = 0 To NFIELDS - 1
        If mCol(f) > lastCol Then lastCol = mCol(f)
    Next
    data = wsM.Range(wsM.Cells(rFirst, 1), wsM.Cells(rLast, lastCol)).Value
    If Not wsP Is Nothing Then pm = wsP.Range(wsP.Cells(pFirst, pStatus), wsP.Cells(pFirst + n, pStatus)).Value

    ReDim parts(0 To n + 600)
    parts(0) = PROTO & vbTab & "sync" & vbTab & mode & vbTab & Esc(Setting(S_TOKEN))
    parts(1) = "B" & vbTab & DriverBase() & vbTab & DriverCur()
    used = 2

    Set seen = New Collection
    For i = 1 To n
        nm = Trim$(TextOf(data(i, mCol(F_NAME))))
        If Len(nm) > 0 Then
            idText = Trim$(TextOf(data(i, cId)))
            baseText = BaseOf(data(i, cBase))
            If Len(idText) > 0 Then
                If MapHas(seen, idText) Or Not IsDigits(idText) Then
                    ' a copied row: the copy is a new part
                    idText = ""
                    baseText = ""
                Else
                    MapSet seen, idText, "1"
                End If
            Else
                baseText = ""
            End If
            If Len(baseText) = 0 Then baseText = String$(NFIELDS - 1, vbTab)
            b = Split(baseText, vbTab)
            cur = ""
            For f = 0 To NFIELDS - 1
                If f = F_STATUS Then
                    If wsP Is Nothing Or pFirst + i - 1 > pLast Then
                        ' no tracker row for this part: its tick is whatever the board says
                        v = b(f)
                    ElseIf LCase$(Trim$(TextOf(pm(i, 1)))) = "in stock" Then
                        v = "1"
                    Else
                        v = "0"
                    End If
                ElseIf mCol(f) = 0 Then
                    v = b(f)
                Else
                    v = Esc(TextOf(data(i, mCol(f))))
                End If
                If f > 0 Then cur = cur & vbTab
                cur = cur & v
            Next
            parts(used) = "R" & vbTab & idText & vbTab & CStr(rFirst + i - 1) & vbTab & baseText & vbTab & cur
            used = used + 1
        End If
    Next

    ' parts this workbook knew that are no longer on the Master List: ask once, then say so to the board
    If mAnswered Is Nothing Then Set mAnswered = New Collection
    Set known = KnownParts()
    For i = 1 To known.Count Step 2
        idText = CStr(known.Item(i))
        If Not MapHas(seen, idText) Then
            If Not MapHas(mAnswered, idText) Then
                asked = asked + 1
                If asked <= 15 Then askList = askList & vbLf & "     " & CStr(known.Item(i + 1))
            End If
        End If
    Next
    If asked > 0 Then
        If asked > 15 Then askList = askList & vbLf & "     and " & CStr(asked - 15) & " more"
        answer = MsgBox("These parts are no longer on the Master List:" & vbLf & askList & vbLf & vbLf & _
                        "Remove them from the board as well?" & vbLf & vbLf & _
                        "Yes = remove them from the board" & vbLf & _
                        "No = put them back in this workbook", vbYesNo + vbQuestion + vbDefaultButton2, TITLE)
        For i = 1 To known.Count Step 2
            idText = CStr(known.Item(i))
            If Not MapHas(seen, idText) Then
                If Not MapHas(mAnswered, idText) Then
                    If answer = vbYes Then
                        MapSet mAnswered, idText, "D"
                    Else
                        MapSet mAnswered, idText, "K"
                    End If
                End If
            End If
        Next
    End If
    For i = 1 To known.Count Step 2
        idText = CStr(known.Item(i))
        If Not MapHas(seen, idText) Then
            If MapGet(mAnswered, idText) = "D" And used < UBound(parts) Then
                parts(used) = "D" & vbTab & idText
                used = used + 1
            End If
        End If
    Next

    ReDim Preserve parts(0 To used - 1)
    BuildBody = Join(parts, vbLf) & vbLf
End Function

' ---------------------------------------------------------------- applying the answer

Private Sub ApplyReply(ByRef lines() As String, ByRef head() As String)
    Dim i As Long, r As Long, f() As String, g() As String
    Dim conflicts As Collection, labels As Collection, known As Collection
    Dim gone As Collection, problems As String, item As Variant
    Dim answer As VbMsgBoxResult, idText As String

    Set conflicts = New Collection
    Set labels = New Collection
    Set known = New Collection
    Set gone = New Collection
    Set mLive = New Collection
    mDidWrite = False
    mStep = "reading the board's answer"

    For i = 1 To UBound(lines)
        If Len(lines(i)) > 0 Then
            SplitLine lines(i), f
            Select Case f(0)
                Case "C"
                    MapSet conflicts, Fld(f, 1) & "|" & Fld(f, 2), Fld(f, 3)
                    MapSet labels, Fld(f, 1) & "|" & Fld(f, 2), Fld(f, 4)
                Case "G"
                    gone.Add Fld(f, 1) & vbTab & Fld(f, 2)
                Case "W", "E"
                    problems = problems & ProblemText(Fld(f, 1), Fld(f, 2)) & vbLf
            End Select
        End If
    Next

    For i = 1 To UBound(lines)
        If Len(lines(i)) > 0 Then
            SplitLine lines(i), f
            If f(0) = "B" Then
                mStep = "writing the quantity drivers"
                ApplyBuild f, conflicts, labels
            ElseIf f(0) = "I" Then
                mLive.Add lines(i)
                mStep = "writing the row of " & Fld(f, 4 + F_NAME)
                ApplyItem f, conflicts, labels, known, problems
            End If
        End If
    Next

    ' rows whose part was removed on the board
    mStep = "handling parts removed on the board"
    For Each item In gone
        g = Split(CStr(item), vbTab)
        r = CLng(Val(g(0)))
        If r >= rFirst And r <= rLast Then
            If Trim$(TextOf(wsM.Cells(r, cId).Value)) = g(1) Then
                answer = MsgBox("""" & TextOf(wsM.Cells(r, mCol(F_NAME)).Value) & """ was removed on the board." & vbLf & vbLf & _
                                "Remove its row from the Master List as well?" & vbLf & vbLf & _
                                "Yes = clear the row here" & vbLf & _
                                "No = keep the row, and add it to the board again", vbYesNo + vbQuestion, TITLE)
                If answer = vbYes Then
                    ClearRow r
                Else
                    wsM.Cells(r, cId).ClearContents
                    wsM.Cells(r, cBase).ClearContents
                    mDidWrite = True
                End If
            End If
        End If
    Next

    ' a row still carrying an id the board no longer lists (deleted here, and confirmed) forgets it
    For r = rFirst To rLast
        idText = Trim$(TextOf(wsM.Cells(r, cId).Value))
        If Len(idText) > 0 Then
            If Not MapHas(known, idText) Then
                wsM.Cells(r, cId).ClearContents
                wsM.Cells(r, cBase).ClearContents
                mDidWrite = True
            End If
        End If
    Next

    mStep = "updating the Board Sync sheet"
    SetSetting S_TOKEN, Fld(head, 2)
    SetSetting S_PROJECT, Fld(head, 3)
    WriteKnown known
    WriteProblems problems
    mStep = "writing the Live Status sheet"
    WriteLive
    If mDidWrite Then SetSetting S_LAST, Fld(head, 4)
    Set mAnswered = Nothing

    If Len(problems) > 0 Then
        Note Fld(head, 3) & " - in step at " & Format$(Now, "hh:nn:ss") & ", but some rows need attention: see the Board Sync sheet."
    Else
        Note Fld(head, 3) & " - in step at " & Format$(Now, "hh:nn:ss")
    End If
End Sub

Private Function ProblemText(ByVal ref As String, ByVal message As String) As String
    Dim r As Long
    If ref = "build" Then
        ProblemText = "Quantity drivers: " & message
        Exit Function
    End If
    r = CLng(Val(ref))
    If r >= rFirst And r <= rLast Then
        ProblemText = "Row " & CStr(r) & " (" & Trim$(TextOf(wsM.Cells(r, mCol(F_NAME)).Value)) & "): " & message
    Else
        ProblemText = message
    End If
End Function

Private Sub ApplyBuild(ByRef f() As String, ByVal conflicts As Collection, ByVal labels As Collection)
    Dim n As Long, v As String, k As String, keep As Boolean, mine As String
    For n = 0 To 2
        v = Fld(f, 1 + n)
        If Not rngDrv(n) Is Nothing Then
            mine = TextOf(rngDrv(n).Value)
            k = "build|" & CStr(n)
            keep = False
            If MapHas(conflicts, k) Then keep = AskConflict("What the project builds", MapGet(labels, k), mine, MapGet(conflicts, k))
            If Not keep Then
                If Val(mine) <> Val(v) Then
                    rngDrv(n).Value = Val(v)
                    mDidWrite = True
                End If
            End If
        End If
    Next
    SetSetting S_DRIVERS, Fld(f, 1) & "|" & Fld(f, 2) & "|" & Fld(f, 3)
End Sub

Private Function AskConflict(ByVal what As String, ByVal label As String, ByVal mine As String, ByVal theirs As String) As Boolean
    If Len(mine) = 0 Then mine = "(empty)"
    If Len(theirs) = 0 Then theirs = "(empty)"
    AskConflict = (MsgBox(what & " - " & label & vbLf & vbLf & _
                          "This was changed in the workbook and on the board." & vbLf & vbLf & _
                          "Workbook:   " & mine & vbLf & _
                          "Board:        " & theirs & vbLf & vbLf & _
                          "Yes = keep the workbook's value (the board is updated)" & vbLf & _
                          "No = take the board's value", vbYesNo + vbQuestion, TITLE) = vbYes)
End Function

Private Function StatusWord(ByVal flag As String) As String
    If flag = "1" Then StatusWord = "In Stock" Else StatusWord = "Pending"
End Function

Private Function RowOfId(ByVal idText As String) As Long
    Dim r As Long
    For r = rFirst To rLast
        If Trim$(TextOf(wsM.Cells(r, cId).Value)) = idText Then
            RowOfId = r
            Exit Function
        End If
    Next
End Function

Private Function FirstEmptyRow() As Long
    Dim r As Long
    For r = rFirst To rLast
        If Len(Trim$(TextOf(wsM.Cells(r, mCol(F_NAME)).Value))) = 0 And Len(Trim$(TextOf(wsM.Cells(r, cId).Value))) = 0 Then
            FirstEmptyRow = r
            Exit Function
        End If
    Next
End Function

' one part of the board's list: I, ok|hold, id, row, the twelve cells, what the Live Status sheet shows, then what to do with Total qty
Private Sub ApplyItem(ByRef f() As String, ByVal conflicts As Collection, ByVal labels As Collection, ByVal known As Collection, ByRef problems As String)
    Dim idText As String, ref As String, r As Long, k As Long, key As String, v As String
    Dim keep As Boolean, isNew As Boolean, baseText As String, mine As String, theirs As String, what As String

    idText = Fld(f, 2)
    ref = Fld(f, 3)

    r = 0
    If Len(ref) > 0 Then
        r = CLng(Val(ref))
        If r < rFirst Or r > rLast Then r = 0
    End If
    If r = 0 Then r = RowOfId(idText)
    If r = 0 Then
        ' a part added on the board: the first empty row
        r = FirstEmptyRow()
        isNew = True
        If r = 0 Then
            problems = problems & "The Master List has no empty row left for """ & Fld(f, 4 + F_NAME) & """ (added on the board)." & vbLf
            Exit Sub
        End If
    End If
    MapSet known, idText, Fld(f, 4 + F_NAME)
    ' a row the board could not save is left exactly as it is, for the person to put right
    If Fld(f, 1) = "hold" Then Exit Sub

    what = Fld(f, 4 + F_NAME)
    For k = 0 To NFIELDS - 1
        v = Fld(f, 4 + k)
        key = idText & "|" & CStr(k)
        keep = False
        If MapHas(conflicts, key) Then
            theirs = MapGet(conflicts, key)
            If k = F_STATUS Then
                mine = StatusWord(CurrentStatus(r))
                theirs = StatusWord(theirs)
            ElseIf mCol(k) > 0 Then
                mine = TextOf(wsM.Cells(r, mCol(k)).Value)
            Else
                mine = ""
            End If
            keep = AskConflict(what, MapGet(labels, key), mine, theirs)
        End If
        If Not keep Then
            If k = F_STATUS Then
                PutStatus r, v, Fld(f, 18)
            ElseIf k = F_TOTAL Then
                PutTotal r, Fld(f, 31)
            Else
                PutField r, k, v
            End If
        End If
    Next

    If Trim$(TextOf(wsM.Cells(r, cId).Value)) <> idText Then
        wsM.Cells(r, cId).Value = "'" & idText
        mDidWrite = True
    End If
    baseText = ""
    For k = 0 To NFIELDS - 1
        If k > 0 Then baseText = baseText & vbTab
        baseText = baseText & Esc(Fld(f, 4 + k))
    Next
    If TextOf(wsM.Cells(r, cBase).Value) <> baseText Then
        wsM.Cells(r, cBase).Value = "'" & baseText
        mDidWrite = True
    End If
    If isNew Then FinishNewRow r
End Sub

' the formula another row has in this column, to give to a row that lacks it
Private Function TemplateFormula(ByVal c As Long, ByVal notRow As Long) As String
    Dim r As Long
    For r = rFirst To rLast
        If r <> notRow Then
            If wsM.Cells(r, c).HasFormula Then
                TemplateFormula = wsM.Cells(r, c).FormulaR1C1
                Exit Function
            End If
        End If
    Next
End Function

Private Sub PutField(ByVal r As Long, ByVal k As Long, ByVal v As String)
    Dim c As Range
    If mCol(k) = 0 Then Exit Sub
    Set c = wsM.Cells(r, mCol(k))
    If TextOf(c.Value) = v Then Exit Sub
    If Len(v) = 0 Then
        c.ClearContents
    ElseIf (k = F_QTY Or k = F_INV) And LooksNumber(v) Then
        c.Value = Val(v)
    Else
        c.Value = SafeText(v)
    End If
    mDidWrite = True
End Sub

' Total qty: the board says what to do with the cell. Nothing: it already shows
' the right total. "F": give it the workbook's own formula, because the part is
' counted by its category. A number: type that total in, because it is not.
Private Sub PutTotal(ByVal r As Long, ByVal action As String)
    Dim c As Range, t As String
    If Len(action) = 0 Then Exit Sub
    Set c = wsM.Cells(r, mCol(F_TOTAL))
    If action = "F" Then
        t = TemplateFormula(mCol(F_TOTAL), r)
        If Len(t) = 0 Then Exit Sub
        If c.HasFormula Then
            If c.FormulaR1C1 = t Then Exit Sub
        End If
        c.FormulaR1C1 = t
        mDidWrite = True
    ElseIf LooksNumber(action) Then
        If Not c.HasFormula Then
            If TextOf(c.Value) = action Then Exit Sub
        End If
        c.Value = Val(action)
        mDidWrite = True
    End If
End Sub

' the Status cell of the Procurement Management tracker that belongs to a Master List row
Private Function StatusCell(ByVal r As Long) As Range
    If wsP Is Nothing Then Exit Function
    If pFirst + (r - rFirst) > pLast Then Exit Function
    Set StatusCell = wsP.Cells(pFirst + (r - rFirst), pStatus)
End Function

Private Function CurrentStatus(ByVal r As Long) As String
    Dim c As Range
    Set c = StatusCell(r)
    CurrentStatus = "0"
    If c Is Nothing Then Exit Function
    If LCase$(Trim$(TextOf(c.Value))) = "in stock" Then CurrentStatus = "1"
End Function

Private Sub PutStatus(ByVal r As Long, ByVal v As String, ByVal stamp As String)
    Dim c As Range, d As Range, stampAt As Date, has As Boolean
    Set c = StatusCell(r)
    If c Is Nothing Then Exit Sub
    If CurrentStatus(r) <> v Then
        c.Value = StatusWord(v)
        mDidWrite = True
    End If
    If pDate = 0 Then Exit Sub
    Set d = wsP.Cells(c.Row, pDate)
    If v = "1" And Len(stamp) >= 16 Then
        ' when the board says it came into stock
        stampAt = DateSerial(CInt(Mid$(stamp, 1, 4)), CInt(Mid$(stamp, 6, 2)), CInt(Mid$(stamp, 9, 2))) + _
               TimeSerial(CInt(Mid$(stamp, 12, 2)), CInt(Mid$(stamp, 15, 2)), 0)
        has = False
        If Not IsEmpty(d.Value) Then
            If IsDate(d.Value) Then has = (Abs(CDbl(CDate(d.Value)) - CDbl(stampAt)) < 0.0007)
        End If
        If Not has Then
            d.Value = stampAt
            If d.NumberFormat = "General" Then d.NumberFormat = "yyyy-mm-dd hh:mm"
            mDidWrite = True
        End If
    ElseIf v <> "1" Then
        If Not IsEmpty(d.Value) Then
            d.ClearContents
            mDidWrite = True
        End If
    End If
End Sub

' a row the macro has just filled for a part added on the board
Private Sub FinishNewRow(ByVal r As Long)
    Dim t As String, top As Double, i As Long, v As Variant
    If cProc > 0 Then
        If IsEmpty(wsM.Cells(r, cProc).Value) And Not wsM.Cells(r, cProc).HasFormula Then
            t = TemplateFormula(cProc, r)
            If Len(t) > 0 Then wsM.Cells(r, cProc).FormulaR1C1 = t
        End If
    End If
    If cItem > 0 Then
        If IsEmpty(wsM.Cells(r, cItem).Value) Then
            For i = rFirst To rLast
                v = wsM.Cells(i, cItem).Value
                If Not IsError(v) Then
                    If IsNumeric(v) And Not IsEmpty(v) Then
                        If CDbl(v) > top Then top = CDbl(v)
                    End If
                End If
            Next
            wsM.Cells(r, cItem).Value = top + 1
        End If
    End If
    mDidWrite = True
End Sub

' empty a row whose part was removed on the board (the row itself stays, so nothing below it moves)
Private Sub ClearRow(ByVal r As Long)
    Dim k As Long, t As String, c As Range
    For k = 0 To NFIELDS - 1
        If k <> F_STATUS And k <> F_TOTAL And mCol(k) > 0 Then wsM.Cells(r, mCol(k)).ClearContents
    Next
    If Not wsM.Cells(r, mCol(F_TOTAL)).HasFormula Then
        t = TemplateFormula(mCol(F_TOTAL), r)
        If Len(t) > 0 Then wsM.Cells(r, mCol(F_TOTAL)).FormulaR1C1 = t Else wsM.Cells(r, mCol(F_TOTAL)).ClearContents
    End If
    If cItem > 0 Then wsM.Cells(r, cItem).ClearContents
    wsM.Cells(r, cId).ClearContents
    wsM.Cells(r, cBase).ClearContents
    Set c = StatusCell(r)
    If Not c Is Nothing Then
        c.ClearContents
        If pDate > 0 Then wsP.Cells(c.Row, pDate).ClearContents
    End If
    mDidWrite = True
End Sub

' forget every tie to the board: the Master List itself is untouched
Private Sub ClearLink()
    Dim ws As Worksheet
    If cId > 0 And cBase > 0 Then
        wsM.Range(wsM.Cells(rFirst, cId), wsM.Cells(rLast, cId)).ClearContents
        wsM.Range(wsM.Cells(rFirst, cBase), wsM.Cells(rLast, cBase)).ClearContents
    End If
    Set ws = SyncSheet(False)
    If Not ws Is Nothing Then
        ws.Cells(S_TOKEN, 2).ClearContents
        ws.Cells(S_PROJECT, 2).ClearContents
        ws.Cells(S_DRIVERS, 2).ClearContents
        ws.Range("D2:E2000").ClearContents
    End If
    Set mAnswered = Nothing
End Sub

' ---------------------------------------------------------------- the Board Sync and Live Status sheets

Private Sub WriteKnown(ByVal known As Collection)
    Dim ws As Worksheet, was As Collection, same As Boolean, arr() As Variant, i As Long, n As Long
    Set ws = SyncSheet(True)
    Set was = KnownParts()
    same = (was.Count = known.Count)
    If same Then
        For i = 1 To known.Count Step 2
            If Not MapHas(was, CStr(known.Item(i))) Then
                same = False
            ElseIf MapGet(was, CStr(known.Item(i))) <> CStr(known.Item(i + 1)) Then
                same = False
            End If
            If Not same Then Exit For
        Next
    End If
    If same Then Exit Sub
    ws.Range("D2:E2000").ClearContents
    n = known.Count \ 2
    If n = 0 Then Exit Sub
    ReDim arr(1 To n, 1 To 2)
    For i = 1 To n
        arr(i, 1) = CStr(known.Item(2 * i - 1))
        arr(i, 2) = CStr(known.Item(2 * i))
    Next
    ws.Range("D2").Resize(n, 2).Value = arr
End Sub

Private Sub WriteProblems(ByVal problems As String)
    Dim ws As Worksheet, a() As String, i As Long
    Set ws = SyncSheet(True)
    If problems = mProblems And ((Len(TextOf(ws.Cells(PROBLEM_ROW, 1).Value)) > 0) = (Len(problems) > 0)) Then Exit Sub
    mProblems = problems
    ws.Range(ws.Cells(PROBLEM_ROW, 1), ws.Cells(PROBLEM_ROW + 400, 1)).ClearContents
    If Len(problems) = 0 Then Exit Sub
    a = Split(problems, vbLf)
    For i = 0 To UBound(a)
        If Len(a(i)) > 0 And i < 400 Then ws.Cells(PROBLEM_ROW + i, 1).Value = "'" & a(i)
    Next
End Sub

' what the board knows about each part, for the workbook's own sheets and formulas to read
Private Sub WriteLive()
    Dim ws As Worksheet, act As Object, arr() As Variant, f() As String, item As Variant
    Dim n As Long, i As Long, c As Long, sig As String, heads As Variant

    heads = Array("Part name", "Final size", "Required", "To procure", "In stock", "In stock since", "Marked by", _
                  "Stage", "In process", "Received", "Accepted", "Rejected", "Vendor promise", _
                  "Order status", "PO reference", "Vendor", "Next action", "Next due")
    n = mLive.Count
    ReDim arr(1 To n + 1, 1 To 18)
    For c = 0 To 17
        arr(1, c + 1) = heads(c)
    Next
    i = 1
    For Each item In mLive
        SplitLine CStr(item), f
        i = i + 1
        arr(i, 1) = Fld(f, 4 + F_NAME)
        arr(i, 2) = Fld(f, 4 + F_SPEC)
        arr(i, 3) = Fld(f, 16)
        arr(i, 4) = Fld(f, 17)
        If Fld(f, 4 + F_STATUS) = "1" Then arr(i, 5) = "Yes" Else arr(i, 5) = "No"
        For c = 6 To 18
            arr(i, c) = Fld(f, 12 + c)
        Next
        For c = 1 To 18
            sig = sig & CStr(arr(i, c)) & vbTab
        Next
        sig = sig & vbLf
    Next
    If sig = mLiveSig Then Exit Sub

    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(SHEET_LIVE)
    On Error GoTo 0
    If ws Is Nothing Then
        Set act = ActiveSheet
        Set ws = ThisWorkbook.Worksheets.Add(After:=ThisWorkbook.Worksheets(ThisWorkbook.Worksheets.Count))
        ws.Name = SHEET_LIVE
        ws.Cells.NumberFormat = "@"
        ws.Rows(1).Font.Bold = True
        ws.Columns(1).ColumnWidth = 30
        ws.Columns(2).ColumnWidth = 26
        ws.Range("C:R").ColumnWidth = 15
        If Not act Is Nothing Then act.Activate
    End If
    ws.Range(ws.Cells(1, 1), ws.Cells(ws.UsedRange.Row + ws.UsedRange.Rows.Count + 1, 18)).ClearContents
    ws.Range("A1").Resize(n + 1, 18).Value = arr
    mLiveSig = sig
End Sub
