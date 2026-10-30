package com.vigiasuite.app

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import com.hoho.android.usbserial.util.SerialInputOutputManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import org.json.JSONArray
import org.json.JSONObject

enum class ConnectionStatus {
    DISCONNECTED,
    DEVICE_FOUND,
    PERMISSION_REQUIRED,
    CONNECTING,
    CONNECTED,
    ERROR,
}

data class SerialUiState(
    val status: ConnectionStatus = ConnectionStatus.DISCONNECTED,
    val deviceName: String = "Sin dispositivo",
    val chipset: String = "—",
    val message: String = "Conecta el NodeMCU ESP-32S mediante un cable OTG de datos.",
    val console: List<String> = emptyList(),
    val wifiNetworks: List<WifiNetwork> = emptyList(),
    val bleDevices: List<BleDevice> = emptyList(),
    val history: List<AnalysisRecord> = emptyList(),
    val isAnalyzing: Boolean = false,
)

data class AnalysisRecord(
    val createdAt: Long,
    val score: Int,
    val level: String,
    val wifiTotal: Int,
    val wifiOpen: Int,
    val bleTotal: Int,
    val bleNearby: Int,
)

data class WifiNetwork(
    val ssid: String,
    val rssi: Int,
    val channel: Int,
    val auth: Int,
    val bssid: String,
)

data class BleDevice(
    val name: String,
    val rssi: Int,
    val address: String,
    val addressType: String,
    val connectable: Boolean,
    val manufacturerId: Int,
    val services: String,
)

class UsbSerialController(context: Context) : SerialInputOutputManager.Listener {
    private val appContext = context.applicationContext
    private val usbManager = appContext.getSystemService(Context.USB_SERVICE) as UsbManager
    private val _state = MutableStateFlow(SerialUiState())
    val state: StateFlow<SerialUiState> = _state.asStateFlow()
    private val preferences = appContext.getSharedPreferences("vigia_history", Context.MODE_PRIVATE)

    private var port: UsbSerialPort? = null
    private var ioManager: SerialInputOutputManager? = null
    private var pendingDevice: UsbDevice? = null
    private var receiverRegistered = false
    private var fullAnalysisPending = false
    private val receiveBuffer = StringBuilder()

    init { loadHistory() }

    private val permissionReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != ACTION_USB_PERMISSION) return
            val device = intent.usbDeviceExtra()
            if (intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false) && device != null) {
                openDevice(device)
            } else {
                update(
                    status = ConnectionStatus.ERROR,
                    message = "Permiso USB rechazado. Pulsa conectar para intentarlo otra vez.",
                )
                log("Permiso USB rechazado")
            }
        }
    }

    fun register() {
        if (receiverRegistered) return
        val filter = IntentFilter(ACTION_USB_PERMISSION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            appContext.registerReceiver(permissionReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            appContext.registerReceiver(permissionReceiver, filter)
        }
        receiverRegistered = true
        discover()
    }

    fun unregister() {
        disconnect()
        if (receiverRegistered) {
            appContext.unregisterReceiver(permissionReceiver)
            receiverRegistered = false
        }
    }

    fun discover() {
        val drivers = UsbSerialProber.getDefaultProber().findAllDrivers(usbManager)
        val driver = drivers.firstOrNull()
        if (driver == null) {
            pendingDevice = null
            update(
                status = ConnectionStatus.DISCONNECTED,
                deviceName = "Sin dispositivo",
                chipset = "—",
                message = "No se encontró un adaptador CP210x o CH340. Revisa el cable OTG.",
            )
            log("Búsqueda finalizada: no se encontró un puerto serial compatible")
            return
        }

        pendingDevice = driver.device
        update(
            status = ConnectionStatus.DEVICE_FOUND,
            deviceName = driver.device.productName ?: driver.device.deviceName,
            chipset = chipsetName(driver.device),
            message = "Dispositivo serial encontrado. Ya puedes solicitar la conexión.",
        )
        log("Dispositivo encontrado VID=%04X PID=%04X".format(driver.device.vendorId, driver.device.productId))
    }

    fun connect() {
        val device = pendingDevice ?: run {
            discover()
            pendingDevice
        }
        if (device == null) return

        if (!usbManager.hasPermission(device)) {
            val permissionIntent = PendingIntent.getBroadcast(
                appContext,
                0,
                Intent(ACTION_USB_PERMISSION).setPackage(appContext.packageName),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            update(
                status = ConnectionStatus.PERMISSION_REQUIRED,
                message = "Android solicitará permiso para usar el puerto USB.",
            )
            usbManager.requestPermission(device, permissionIntent)
            return
        }
        openDevice(device)
    }

    private fun openDevice(device: UsbDevice) {
        disconnect(updateUi = false)
        update(status = ConnectionStatus.CONNECTING, message = "Abriendo puerto a 115200 baudios…")

        try {
            val driver = UsbSerialProber.getDefaultProber().probeDevice(device)
                ?: error("No existe un controlador compatible para el dispositivo")
            val connection = usbManager.openDevice(device)
                ?: error("Android no pudo abrir el dispositivo USB")
            val selectedPort = driver.ports.firstOrNull()
                ?: error("El dispositivo no expone puertos seriales")

            selectedPort.open(connection)
            selectedPort.setParameters(
                BAUD_RATE,
                8,
                UsbSerialPort.STOPBITS_1,
                UsbSerialPort.PARITY_NONE,
            )
            selectedPort.dtr = true
            selectedPort.rts = true

            port = selectedPort
            ioManager = SerialInputOutputManager(selectedPort, this).also { it.start() }
            update(
                status = ConnectionStatus.CONNECTED,
                deviceName = device.productName ?: device.deviceName,
                chipset = chipsetName(device),
                message = "NodeMCU conectado. Envía PING para validar el firmware.",
            )
            log("Puerto abierto: 115200 8N1")
            send("PING")
        } catch (error: Exception) {
            disconnect(updateUi = false)
            update(status = ConnectionStatus.ERROR, message = error.message ?: "Error USB desconocido")
            log("Error de conexión: ${error.message}")
        }
    }

    fun send(command: String) {
        val activePort = port
        if (activePort == null) {
            log("No se envió $command: el sensor no está conectado")
            return
        }

        try {
            val payload = "$command\n".toByteArray(StandardCharsets.UTF_8)
            activePort.write(payload, WRITE_TIMEOUT_MS)
            log("> $command")
        } catch (error: IOException) {
            update(status = ConnectionStatus.ERROR, message = "Se perdió la comunicación USB")
            log("Error al escribir: ${error.message}")
        }
    }

    fun runFullAnalysis() {
        if (port == null || _state.value.isAnalyzing) return
        fullAnalysisPending = true
        _state.value = _state.value.copy(isAnalyzing = true, wifiNetworks = emptyList(), bleDevices = emptyList(), message = "Iniciando evaluación guiada…")
        send("SCAN_WIFI")
    }

    fun disconnect(updateUi: Boolean = true) {
        ioManager?.listener = null
        ioManager?.stop()
        ioManager = null
        try {
            port?.close()
        } catch (_: IOException) {
            // The USB device may already have been detached.
        }
        port = null
        fullAnalysisPending = false
        if (updateUi) {
            _state.value = _state.value.copy(status = ConnectionStatus.DISCONNECTED, message = "Sensor desconectado.", isAnalyzing = false)
            log("Conexión cerrada")
        }
    }

    override fun onNewData(data: ByteArray) {
        val completeLines = mutableListOf<String>()
        synchronized(receiveBuffer) {
            receiveBuffer.append(data.toString(StandardCharsets.UTF_8).replace("\r", ""))
            while (true) {
                val newline = receiveBuffer.indexOf("\n")
                if (newline < 0) break
                completeLines += receiveBuffer.substring(0, newline)
                receiveBuffer.delete(0, newline + 1)
            }
        }
        completeLines.filter { it.isNotBlank() }.forEach(::handleLine)
    }

    override fun onRunError(error: Exception) {
        update(status = ConnectionStatus.ERROR, message = "Lectura USB detenida: ${error.message}")
        log("Error de lectura: ${error.message}")
    }

    private fun chipsetName(device: UsbDevice): String = when (device.vendorId) {
        0x10C4 -> "Silicon Labs CP210x"
        0x1A86 -> "QinHeng CH340/CH341"
        0x303A -> "Espressif USB"
        else -> "VID %04X / PID %04X".format(device.vendorId, device.productId)
    }

    private fun handleLine(line: String) {
        log("< $line")
        try {
            val event = JSONObject(line)
            when (event.optString("type")) {
                "ready" -> update(message = "Firmware ${event.optString("firmware")} listo.")
                "pong" -> update(message = "Enlace validado: el ESP32 respondió correctamente.")
                "identity" -> update(
                    message = "${event.optString("board")} · ${event.optString("chip")} · ${event.optString("mac")}",
                )
                "status" -> update(
                    message = "Memoria libre: ${event.optLong("heap_free")} bytes · Activo: ${event.optLong("uptime_ms") / 1000} s",
                )
                "wifi_scan_started" -> _state.value = _state.value.copy(
                    wifiNetworks = emptyList(),
                    message = "Analizando redes Wi-Fi…",
                )
                "wifi_ap" -> {
                    val network = WifiNetwork(
                        ssid = event.optString("ssid"),
                        rssi = event.optInt("rssi"),
                        channel = event.optInt("channel"),
                        auth = event.optInt("auth"),
                        bssid = event.optString("bssid"),
                    )
                    _state.value = _state.value.copy(wifiNetworks = _state.value.wifiNetworks + network)
                }
                "wifi_scan_finished" -> {
                    update(message = "Wi-Fi finalizado: ${event.optInt("count")} redes detectadas.")
                    if (fullAnalysisPending) send("SCAN_BLE")
                }
                "ble_scan_started" -> _state.value = _state.value.copy(
                    bleDevices = emptyList(),
                    message = "Analizando Bluetooth LE durante 5 segundos…",
                )
                "ble_device" -> {
                    val device = BleDevice(
                        name = event.optString("name"),
                        rssi = event.optInt("rssi"),
                        address = event.optString("address"),
                        addressType = event.optString("address_type", "unknown"),
                        connectable = event.optBoolean("connectable"),
                        manufacturerId = event.optInt("manufacturer_id", -1),
                        services = event.optString("services"),
                    )
                    val devices = _state.value.bleDevices.toMutableList()
                    val existing = devices.indexOfFirst { it.address == device.address }
                    if (existing >= 0) devices[existing] = device else devices += device
                    _state.value = _state.value.copy(bleDevices = devices)
                }
                "ble_scan_finished" -> {
                    val failed = event.optBoolean("failed")
                    _state.value = _state.value.copy(
                        message = if (failed) "El inventario Bluetooth no pudo completarse."
                        else "Evaluación terminada: ${event.optInt("count")} dispositivos Bluetooth detectados.",
                        isAnalyzing = false,
                    )
                    fullAnalysisPending = false
                    if (!failed) recordAnalysis()
                }
                "ble_status" -> update(
                    message = if (event.optBoolean("ready")) "Bluetooth LE disponible y listo."
                    else "Bluetooth LE no pudo inicializarse.",
                )
                "error" -> {
                    fullAnalysisPending = false
                    _state.value = _state.value.copy(message = "El sensor reportó: ${event.optString("code")}", isAnalyzing = false)
                }
            }
        } catch (_: Exception) {
            // El cargador de arranque también puede escribir mensajes que no son JSON.
        }
    }

    private fun update(
        status: ConnectionStatus = _state.value.status,
        deviceName: String = _state.value.deviceName,
        chipset: String = _state.value.chipset,
        message: String = _state.value.message,
    ) {
        _state.value = _state.value.copy(
            status = status,
            deviceName = deviceName,
            chipset = chipset,
            message = message,
        )
    }

    private fun log(message: String) {
        val timestamp = LocalTime.now().format(DateTimeFormatter.ofPattern("HH:mm:ss"))
        _state.value = _state.value.copy(
            console = (_state.value.console + "[$timestamp] $message").takeLast(MAX_LOG_LINES),
        )
    }

    fun clearHistory() {
        preferences.edit().remove(HISTORY_KEY).apply()
        _state.value = _state.value.copy(history = emptyList())
    }

    private fun recordAnalysis() {
        val wifi = _state.value.wifiNetworks
        val ble = _state.value.bleDevices
        if (wifi.isEmpty() && ble.isEmpty()) return
        val open = wifi.count { it.auth == 0 }
        val weak = wifi.count { it.auth == 1 || it.auth == 2 }
        val strongOpen = wifi.count { it.auth == 0 && it.rssi >= -70 }
        val stableNearby = ble.count { it.rssi >= -65 && !it.addressType.contains("random") && it.connectable }
        var score = minOf(40, open * 3) + minOf(25, strongOpen * 5) + minOf(25, weak * 12) + minOf(10, stableNearby * 2)
        if (wifi.isNotEmpty() && open.toFloat() / wifi.size >= .25f) score += 10
        score = minOf(100, score)
        val record = AnalysisRecord(
            createdAt = System.currentTimeMillis(), score = score,
            level = if (score >= 60) "ALTO" else if (score >= 30) "MEDIO" else "BAJO",
            wifiTotal = wifi.size, wifiOpen = open, bleTotal = ble.size, bleNearby = ble.count { it.rssi >= -65 },
        )
        val updated = (listOf(record) + _state.value.history).take(20)
        _state.value = _state.value.copy(history = updated)
        saveHistory(updated)
    }

    private fun saveHistory(items: List<AnalysisRecord>) {
        val array = JSONArray()
        items.forEach { item -> array.put(JSONObject().apply {
            put("createdAt", item.createdAt); put("score", item.score); put("level", item.level)
            put("wifiTotal", item.wifiTotal); put("wifiOpen", item.wifiOpen)
            put("bleTotal", item.bleTotal); put("bleNearby", item.bleNearby)
        }) }
        preferences.edit().putString(HISTORY_KEY, array.toString()).apply()
    }

    private fun loadHistory() {
        val items = mutableListOf<AnalysisRecord>()
        try {
            val array = JSONArray(preferences.getString(HISTORY_KEY, "[]"))
            for (index in 0 until array.length()) array.getJSONObject(index).let { item -> items += AnalysisRecord(
                item.optLong("createdAt"), item.optInt("score"), item.optString("level"),
                item.optInt("wifiTotal"), item.optInt("wifiOpen"), item.optInt("bleTotal"), item.optInt("bleNearby"),
            ) }
        } catch (_: Exception) { preferences.edit().remove(HISTORY_KEY).apply() }
        _state.value = _state.value.copy(history = items)
    }

    @Suppress("DEPRECATION")
    private fun Intent.usbDeviceExtra(): UsbDevice? = if (Build.VERSION.SDK_INT >= 33) {
        getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
    } else {
        getParcelableExtra(UsbManager.EXTRA_DEVICE)
    }

    private companion object {
        const val ACTION_USB_PERMISSION = "com.vigiasuite.app.USB_PERMISSION"
        const val BAUD_RATE = 115200
        const val WRITE_TIMEOUT_MS = 1_000
        const val MAX_LOG_LINES = 120
        const val HISTORY_KEY = "analysis_records_v1"
    }
}

