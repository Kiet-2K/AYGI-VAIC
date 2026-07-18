class Violation {
  final String id;
  final String cccd;
  final String licensePlate;
  final String vehicleModel;
  final String violationType;
  final String location;
  final DateTime dateTime;
  final double fineAmount;
  final String imageUrl;
  bool isPaid;
  final String paymentQrData;

  Violation({
    required this.id,
    required this.cccd,
    required this.licensePlate,
    required this.vehicleModel,
    required this.violationType,
    required this.location,
    required this.dateTime,
    required this.fineAmount,
    required this.imageUrl,
    this.isPaid = false,
    required this.paymentQrData,
  });
}
