// LiquidDesktop login screen for SDDM (Qt 6): the wallpaper, a big clock, your picture and a glass password
// field, plus the session picker and Sleep / Restart / Shut Down.
import QtQuick
import QtQuick.Controls
import QtQuick.Effects

Rectangle {
    id: root
    width: 1920; height: 1080
    color: "#1c2a44"

    readonly property real s: Math.max(0.75, Math.min(width / 1440, height / 900))   // scale with the screen
    property int sessionIndex: sessionModel.lastIndex >= 0 ? sessionModel.lastIndex : 0
    property bool busy: false

    // userModel / sessionModel have no index accessors: Repeaters create one (invisible) item per entry
    property int userIndex: userModel.lastIndex >= 0 ? userModel.lastIndex : 0
    Repeater {
        id: users
        model: userModel
        delegate: Item {
            visible: false
            property string uName: model.name
            property string uReal: model.realName || model.name
            property string uIcon: model.icon || ""
        }
    }
    readonly property var userItem: users.count > 0 ? users.itemAt(Math.min(userIndex, users.count - 1)) : null
    readonly property string userName: userItem ? userItem.uName : userModel.lastUser
    readonly property string realName: userItem ? userItem.uReal : userModel.lastUser
    readonly property string userIcon: userItem ? userItem.uIcon : ""

    Repeater {
        id: sessions
        model: sessionModel
        delegate: Item { visible: false; property string sName: model.name }
    }
    function sessionName(i) { const it = sessions.count > 0 ? sessions.itemAt(i) : null; return it ? it.sName : "Session" }

    /* ------------------------------------------------------------ background */
    Image {
        id: bg
        anchors.fill: parent
        source: config.background ? Qt.resolvedUrl(config.background) : "background.jpg"
        fillMode: Image.PreserveAspectCrop
        asynchronous: false
    }
    // a soft darkening towards the bottom so the controls read well on any wallpaper
    Rectangle {
        anchors.fill: parent
        gradient: Gradient {
            GradientStop { position: 0.0; color: "#26000000" }
            GradientStop { position: 0.45; color: "#00000000" }
            GradientStop { position: 1.0; color: "#59000000" }
        }
    }

    /* ------------------------------------------------------------ clock */
    Column {
        id: clockCol
        anchors.horizontalCenter: parent.horizontalCenter
        y: parent.height * 0.08
        spacing: -6 * root.s
        layer.enabled: true
        layer.effect: MultiEffect { shadowEnabled: true; shadowColor: "#55000000"; shadowBlur: 0.6; shadowVerticalOffset: 2 }

        Text {
            id: dateText
            anchors.horizontalCenter: parent.horizontalCenter
            color: "#f2ffffff"
            font.pixelSize: 24 * root.s
            font.weight: Font.DemiBold
        }
        Text {
            id: timeText
            anchors.horizontalCenter: parent.horizontalCenter
            color: "#ebffffff"
            font.pixelSize: 112 * root.s
            font.weight: Font.Bold
            font.letterSpacing: -2 * root.s
        }
        Timer {
            interval: 1000; running: true; repeat: true; triggeredOnStart: true
            onTriggered: {
                const now = new Date()
                dateText.text = now.toLocaleDateString(Qt.locale(), "dddd, MMMM d")
                const h24 = config.clock24 === "true" || config.clock24 === true
                timeText.text = h24 ? now.toLocaleTimeString(Qt.locale(), "HH:mm") : now.toLocaleTimeString(Qt.locale(), "h:mm AP").replace(/\s*[AP]M$/i, "")
            }
        }
    }

    /* ------------------------------------------------------------ user + password */
    Column {
        id: loginCol
        anchors.horizontalCenter: parent.horizontalCenter
        y: parent.height * 0.62
        spacing: 12 * root.s

        Row {
            anchors.horizontalCenter: parent.horizontalCenter
            spacing: 18 * root.s

            // previous / next user (only with several accounts)
            Image {
                visible: userModel.count > 1
                anchors.verticalCenter: parent.verticalCenter
                width: 22 * root.s; height: width; source: "chevron.svg"; rotation: 180; opacity: prevArea.containsMouse ? 1 : 0.6
                sourceSize: Qt.size(width * 2, height * 2)
                MouseArea { id: prevArea; anchors.fill: parent; hoverEnabled: true; onClicked: { root.userIndex = (root.userIndex + userModel.count - 1) % userModel.count; password.text = ""; password.forceActiveFocus() } }
            }

            Item {
                id: avatar
                width: 92 * root.s; height: width
                Rectangle {
                    id: avatarBg
                    anchors.fill: parent; radius: width / 2
                    layer.enabled: true
                    layer.effect: MultiEffect { shadowEnabled: true; shadowColor: "#55000000"; shadowBlur: 0.6; shadowVerticalOffset: 3 }
                    gradient: Gradient { GradientStop { position: 0; color: "#b4b4bc" } GradientStop { position: 1; color: "#75757e" } }
                    Text { anchors.centerIn: parent; visible: avatarImg.status !== Image.Ready; text: (root.realName || "?").charAt(0).toUpperCase(); color: "white"; font.pixelSize: 38 * root.s; font.weight: Font.DemiBold }
                }
                Image {
                    id: avatarImg
                    anchors.fill: parent
                    source: root.userIcon
                    fillMode: Image.PreserveAspectCrop
                    sourceSize: Qt.size(width * 2, height * 2)
                    visible: false
                }
                Rectangle { id: avatarMask; anchors.fill: parent; radius: width / 2; visible: false; layer.enabled: true }
                MultiEffect {
                    anchors.fill: parent
                    source: avatarImg
                    visible: avatarImg.status === Image.Ready
                    maskEnabled: true
                    maskSource: avatarMask
                    autoPaddingEnabled: false
                }
                Rectangle { anchors.fill: parent; radius: width / 2; color: "transparent"; border.color: "#59ffffff"; border.width: 1 }
            }

            Image {
                visible: userModel.count > 1
                anchors.verticalCenter: parent.verticalCenter
                width: 22 * root.s; height: width; source: "chevron.svg"; opacity: nextArea.containsMouse ? 1 : 0.6
                sourceSize: Qt.size(width * 2, height * 2)
                MouseArea { id: nextArea; anchors.fill: parent; hoverEnabled: true; onClicked: { root.userIndex = (root.userIndex + 1) % userModel.count; password.text = ""; password.forceActiveFocus() } }
            }
        }

        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            text: root.realName
            color: "white"
            font.pixelSize: 19 * root.s
            font.weight: Font.DemiBold
            layer.enabled: true
            layer.effect: MultiEffect { shadowEnabled: true; shadowColor: "#66000000"; shadowBlur: 0.5; shadowVerticalOffset: 1 }
        }

        // the glass password field
        Rectangle {
            id: field
            anchors.horizontalCenter: parent.horizontalCenter
            width: 250 * root.s; height: 38 * root.s; radius: height / 2
            color: password.activeFocus ? "#47ffffff" : "#33ffffff"
            border.color: "#66ffffff"; border.width: 1
            Behavior on color { ColorAnimation { duration: 150 } }

            TextField {
                id: password
                anchors.fill: parent
                anchors.leftMargin: 16 * root.s
                anchors.rightMargin: 40 * root.s
                echoMode: TextInput.Password
                passwordCharacter: "●"
                color: "white"
                font.pixelSize: 15 * root.s
                font.letterSpacing: echoMode === TextInput.Password && text.length ? 2 : 0
                verticalAlignment: TextInput.AlignVCenter
                background: Item {}
                focus: true
                enabled: !root.busy
                Keys.onReturnPressed: root.doLogin()
                Keys.onEnterPressed: root.doLogin()
                Keys.onEscapePressed: text = ""
                onTextChanged: errorText.opacity = 0
            }
            Text {
                anchors.left: parent.left; anchors.leftMargin: 16 * root.s
                anchors.verticalCenter: parent.verticalCenter
                visible: password.text.length === 0
                text: root.busy ? "Logging in…" : "Enter Password"
                color: "#d9ffffff"; font.pixelSize: 15 * root.s
            }
            Rectangle {
                anchors.right: parent.right; anchors.rightMargin: 5 * root.s
                anchors.verticalCenter: parent.verticalCenter
                width: 28 * root.s; height: width; radius: width / 2
                color: goArea.containsMouse ? "#66ffffff" : "#40ffffff"
                visible: password.text.length > 0 && !root.busy
                Image { anchors.centerIn: parent; width: 16 * root.s; height: width; source: "arrow.svg"; sourceSize: Qt.size(width * 2, height * 2) }
                MouseArea { id: goArea; anchors.fill: parent; hoverEnabled: true; onClicked: root.doLogin() }
            }

            SequentialAnimation {
                id: shake
                property real x0: 0
                NumberAnimation { target: field; property: "anchors.horizontalCenterOffset"; to: -14; duration: 50 }
                NumberAnimation { target: field; property: "anchors.horizontalCenterOffset"; to: 12; duration: 70 }
                NumberAnimation { target: field; property: "anchors.horizontalCenterOffset"; to: -8; duration: 70 }
                NumberAnimation { target: field; property: "anchors.horizontalCenterOffset"; to: 5; duration: 60 }
                NumberAnimation { target: field; property: "anchors.horizontalCenterOffset"; to: 0; duration: 50 }
            }
        }

        Text {
            id: errorText
            anchors.horizontalCenter: parent.horizontalCenter
            text: "Incorrect password"
            color: "#ffd5d5"
            font.pixelSize: 13 * root.s
            opacity: 0
            Behavior on opacity { NumberAnimation { duration: 200 } }
        }
    }

    function doLogin() {
        if (root.busy || !password.text.length) return
        root.busy = true
        sddm.login(root.userName, password.text, root.sessionIndex)
    }
    Connections {
        target: sddm
        function onLoginFailed() {
            root.busy = false
            password.text = ""
            errorText.opacity = 1
            shake.start()
            password.forceActiveFocus()
        }
        function onLoginSucceeded() { root.busy = false }
    }

    /* ------------------------------------------------------------ bottom: session + power */
    // session picker (bottom left)
    Rectangle {
        id: sessionBtn
        anchors.left: parent.left; anchors.bottom: parent.bottom
        anchors.leftMargin: 28 * root.s; anchors.bottomMargin: 28 * root.s
        height: 34 * root.s; width: sessionLabel.implicitWidth + 36 * root.s; radius: height / 2
        color: sessionArea.containsMouse || sessionMenu.visible ? "#47ffffff" : "#2effffff"
        border.color: "#4dffffff"; border.width: 1
        Text {
            id: sessionLabel
            anchors.centerIn: parent
            text: root.sessionName(root.sessionIndex) + "  ▾"
            color: "white"; font.pixelSize: 13 * root.s; font.weight: Font.Medium
        }
        MouseArea { id: sessionArea; anchors.fill: parent; hoverEnabled: true; onClicked: sessionMenu.visible ? sessionMenu.close() : sessionMenu.open() }

        Popup {
            id: sessionMenu
            y: -height - 8 * root.s
            padding: 6 * root.s
            background: Rectangle { color: "#d9f4f4f7"; radius: 12 * root.s; border.color: "#33000000"; border.width: 1 }
            contentItem: Column {
                Repeater {
                    model: sessionModel
                    delegate: Rectangle {
                        width: Math.max(200 * root.s, sname.implicitWidth + 40 * root.s); height: 30 * root.s; radius: 7 * root.s
                        color: index === root.sessionIndex ? "#0a84ff" : (sArea.containsMouse ? "#1f000000" : "transparent")
                        Text { id: sname; anchors.verticalCenter: parent.verticalCenter; x: 12 * root.s; text: model.name; font.pixelSize: 13 * root.s; color: index === root.sessionIndex ? "white" : "#1c1c1e" }
                        MouseArea { id: sArea; anchors.fill: parent; hoverEnabled: true; onClicked: { root.sessionIndex = index; sessionMenu.close(); password.forceActiveFocus() } }
                    }
                }
            }
        }
    }

    // Sleep / Restart / Shut Down (bottom centre, like macOS)
    Row {
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.bottom: parent.bottom; anchors.bottomMargin: 26 * root.s
        spacing: 34 * root.s
        Repeater {
            model: [
                { label: "Sleep", icon: "sleep.svg", act: "suspend", ok: sddm.canSuspend },
                { label: "Restart", icon: "restart.svg", act: "reboot", ok: sddm.canReboot },
                { label: "Shut Down", icon: "shutdown.svg", act: "powerOff", ok: sddm.canPowerOff }
            ]
            delegate: Column {
                visible: modelData.ok
                spacing: 6 * root.s
                Rectangle {
                    anchors.horizontalCenter: parent.horizontalCenter
                    width: 42 * root.s; height: width; radius: width / 2
                    color: pArea.containsMouse ? "#4dffffff" : "#2effffff"
                    border.color: "#4dffffff"; border.width: 1
                    Image { anchors.centerIn: parent; width: 20 * root.s; height: width; source: modelData.icon; sourceSize: Qt.size(width * 2, height * 2) }
                    MouseArea { id: pArea; anchors.fill: parent; hoverEnabled: true; onClicked: sddm[modelData.act]() }
                }
                Text { anchors.horizontalCenter: parent.horizontalCenter; text: modelData.label; color: "#e6ffffff"; font.pixelSize: 12 * root.s }
            }
        }
    }

    Component.onCompleted: password.forceActiveFocus()
}
